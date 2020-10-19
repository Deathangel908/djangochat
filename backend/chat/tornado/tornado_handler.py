import json
import logging
from datetime import timedelta

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db.models import F, Q, Count
from itertools import chain
from tornado import ioloop, gen
from tornado.websocket import WebSocketHandler, WebSocketClosedError

from chat.models import User, Message, UserJoinedInfo, Room, RoomUsers, UserProfile
from chat.py2_3 import str_type
from chat.tornado.anti_spam import AntiSpam
from chat.tornado.constants import VarNames, HandlerNames, Actions, RedisPrefix
from chat.tornado.message_creator import MessagesCreator
from chat.tornado.message_handler import MessagesHandler, WebRtcMessageHandler
from chat.utils import execute_query, get_message_images_videos, get_history_message_query, create_id, \
	get_or_create_ip_model

parent_logger = logging.getLogger(__name__)


class Error401(Exception):
	pass


class TornadoHandler(WebSocketHandler, WebRtcMessageHandler):

	def __init__(self, *args, **kwargs):
		super(TornadoHandler, self).__init__(*args, **kwargs)
		self.__connected__ = False
		self.restored_connection = False
		self.anti_spam = AntiSpam()

	@property
	def connected(self):
		return self.__connected__

	@connected.setter
	def connected(self, value):
		self.__connected__ = value

	def data_received(self, chunk):
		pass

	def on_message(self, json_message):
		message = None
		try:
			if not self.connected:
				raise ValidationError('Skipping message %s, as websocket is not initialized yet' % json_message)
			if not json_message:
				raise Exception('Skipping null message')
			# self.anti_spam.check_spam(json_message)
			self.logger.debug('<< %.1000s', json_message)
			message = json.loads(json_message)
			if message[VarNames.EVENT] not in self.process_ws_message:
				raise Exception("event {} is unknown".format(message[VarNames.EVENT]))
			channel = message.get(VarNames.ROOM_ID)
			if channel and channel not in self.channels:
				raise ValidationError('Access denied for channel {}. Allowed channels: {}'.format(channel, self.channels))
			self.process_ws_message[message[VarNames.EVENT]](message)
		except ValidationError as e:
			error_message = self.default(str(e.message), Actions.GROWL_MESSAGE, HandlerNames.WS)
			if message:
				error_message[VarNames.JS_MESSAGE_ID] = message.get(VarNames.JS_MESSAGE_ID, None)
			self.ws_write(error_message)

	def on_close(self):
		if self.async_redis.subscribed:
			self.logger.info("Close event, unsubscribing from %s", self.channels)
			self.async_redis.unsubscribe(self.channels)
		else:
			self.logger.info("Close event, not subscribed, channels: %s", self.channels)
		self.async_redis_publisher.srem(RedisPrefix.ONLINE_VAR, self.id)
		is_online, online = self.get_online_and_status_from_redis()
		if self.connected:
			if not is_online:
				message = self.room_online_logout(online)
				self.publish(message, settings.ALL_ROOM_ID)
			res = execute_query(settings.UPDATE_LAST_READ_MESSAGE, [self.user_id, ])
			self.logger.info("Updated %s last read message", res)
		self.disconnect()

	def disconnect(self, tries=0):
		"""
		Closes a connection if it's not in proggress, otherwice timeouts closing
		https://github.com/evilkost/brukva/issues/25#issuecomment-9468227
		"""
		self.connected = False
		self.closed_channels = self.channels
		self.channels = []
		if self.async_redis.connection.in_progress and tries < 1000:  # failsafe eternal loop
			self.logger.debug('Closing a connection timeouts')
			ioloop.IOLoop.instance().add_timeout(timedelta(0.00001), self.disconnect, tries+1)
		else:
			self.logger.info("Close connection result: %s")
			self.async_redis.disconnect()

	def generate_self_id(self):
		"""
		When user opens new tab in browser wsHandler.wsConnectionId stores Id of current ws
		So if ws loses a connection it still can reconnect with same id,
		and TornadoHandler can restore webrtc_connections to previous state
		"""
		conn_arg = self.get_argument('id', None)
		self.id, random = create_id(self.user_id, conn_arg)
		self.restored_connection =  random == conn_arg
		self.restored_connection = False
		self.save_ip()

	def open(self):
		session_key = self.get_argument('sessionId', None)
		user_id = self.sync_redis.hget('sessions', session_key)
		if user_id is None:
			self.logger.warning('!! Session key %s has been rejected' % session_key)
			self.close(403, "Session key %s has been rejected" % session_key)
			return
		self.user_id = int(user_id)
		self.ip = self.get_client_ip()
		user_db = UserProfile.objects.get(id=self.user_id)
		self.generate_self_id()
		self._logger = logging.LoggerAdapter(parent_logger, {
			'id': self.id,
			'ip': self.ip
		})
		self.logger.debug("!! Incoming connection, session %s, thread hash %s", session_key, self.id)
		self.async_redis.connect()
		self.async_redis_publisher.sadd(RedisPrefix.ONLINE_VAR, self.id)
		# since we add user to online first, latest trigger will always show correct online
		was_online, online = self.get_online_and_status_from_redis()
		user_rooms_query = Room.objects.filter(users__id=self.user_id, disabled=False) \
			.values('id', 'name', 'roomusers__notifications', 'roomusers__volume')
		room_users = [{
			VarNames.ROOM_ID: room['id'],
			VarNames.ROOM_NAME: room['name'],
			VarNames.NOTIFICATIONS: room['roomusers__notifications'],
			VarNames.VOLUME: room['roomusers__volume'],
			VarNames.ROOM_USERS: []
		} for room in user_rooms_query]
		user_rooms_dict = {room[VarNames.ROOM_ID]: room for room in room_users}
		room_ids = [room_id[VarNames.ROOM_ID] for room_id in room_users]
		rooms_users = RoomUsers.objects.filter(room_id__in=room_ids).values('user_id', 'room_id')
		for ru in rooms_users:
			user_rooms_dict[ru['room_id']][VarNames.ROOM_USERS].append(ru['user_id'])
		# get all missed messages
		self.channels = room_ids  # py2 doesn't support clear()
		self.channels.append(self.channel)
		self.channels.append(self.id)
		self.listen(self.channels)
		off_messages, history = self.get_offline_messages(room_users, was_online, self.get_argument('history', False))
		for room in room_users:
			room_id = room[VarNames.ROOM_ID]
			h = history.get(room_id)
			o = off_messages.get(room_id)
			if h:
				room[VarNames.LOAD_MESSAGES_HISTORY] = h
			if o:
				room[VarNames.LOAD_MESSAGES_OFFLINE] = o

		if settings.SHOW_COUNTRY_CODE:
			fetched_users  = User.objects.annotate(user_c=Count('id')).values('id', 'username', 'sex', 'userjoinedinfo__ip__country_code', 'userjoinedinfo__ip__country', 'userjoinedinfo__ip__region', 'userjoinedinfo__ip__city')
			user_dict = [RedisPrefix.set_js_user_structure_flag(
				user['id'],
				user['username'],
				user['sex'],
				user['userjoinedinfo__ip__country_code'],
				user['userjoinedinfo__ip__country'],
				user['userjoinedinfo__ip__region'],
				user['userjoinedinfo__ip__city']
			) for user in fetched_users]
		else:
			fetched_users = User.objects.values('id', 'username', 'sex')
			user_dict = [RedisPrefix.set_js_user_structure(
				user['id'],
				user['username'],
				user['sex']
			) for user in fetched_users]
		if self.user_id not in online:
			online.append(self.user_id)

		self.ws_write(self.set_room(room_users, user_dict, online, user_db))
		if not was_online:  # if a new tab has been opened
			online_user_names_mes = self.room_online_login(online, user_db.username, user_db.sex_str)
			self.logger.info('!! First tab, sending refresh online for all')
			self.publish(online_user_names_mes, settings.ALL_ROOM_ID)
		self.logger.info("!! User %s subscribes for %s", self.user_id, self.channels)
		self.connected = True

	def get_offline_messages(self, user_rooms, was_online, with_history):
		q_objects = get_history_message_query(self.get_argument('messages', None), user_rooms, with_history)
		if was_online:
			off_messages = []
		else:
			off_messages = Message.objects.filter(
				id__gt=F('room__roomusers__last_read_message_id'),
				room__roomusers__user_id=self.user_id
			)
		off = {}
		history = {}
		if len(q_objects.children) > 0:
			history_messages = Message.objects.filter(q_objects)
			all = list(chain(off_messages, history_messages))
			self.logger.info("Offline messages IDs: %s, history messages: %s", [m.id for m in off_messages], [m.id for m in history_messages])
		else:
			history_messages = []
			all = off_messages
		if self.restored_connection:
			off_messages = all
			history_messages = []
		imv = get_message_images_videos(all)
		self.set_video_images_messages(imv, off_messages, off)
		self.set_video_images_messages(imv, history_messages, history)
		return off, history

	def set_video_images_messages(self, imv, inm, outm):
		for message in inm:
			files = MessagesCreator.prepare_img_video(imv, message.id)
			prep_m = self.create_message(message, files)
			outm.setdefault(message.room_id, []).append(prep_m)

	def check_origin(self, origin):
		"""
		check whether browser set domain matches origin
		"""
		return True # we don't use cookies

	@gen.coroutine
	def save_ip(self):
		"""
		This code is not used anymore
		"""
		if not UserJoinedInfo.objects.filter(
				Q(ip__ip=self.ip) & Q(user_id=self.user_id)).exists():
			ip = yield from get_or_create_ip_model(self.ip, self.logger)
			UserJoinedInfo.objects.create(ip=ip, user_id=self.user_id)

	def ws_write(self, message):
		"""
		Tries to send message, doesn't throw exception outside
		:type self: MessagesHandler
		:type message object
		"""
		# self.logger.debug('<< THREAD %s >>', os.getppid())
		try:
			if isinstance(message, dict):
				message = json.dumps(message)
			if not isinstance(message, str_type):
				raise ValueError('Wrong message type : %s' % str(message))
			self.logger.debug(">> %.1000s", message)
			self.write_message(message)
		except WebSocketClosedError as e:
			self.logger.warning("%s. Can't send message << %s >> ", e, str(message))

	def get_client_ip(self):
		return self.request.headers.get("X-Real-IP") or self.request.remote_ip
