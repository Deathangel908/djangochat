import {WEBRTC_STUNT_URL} from '@/utils/singletons';
import {Logger} from 'lines-logger';
import loggerFactory from '@/utils/loggerFactory';
import WsHandler from '@/utils/WsHandler';
import {bytesToSize, extractError} from '@/utils/utils';

import {sub} from '@/utils/sub';
import MessageHandler from '@/utils/MesageHandler';
import Subscription from '@/utils/Subscription';
import {ConnectionStatus, RemovePeerConnection} from '@/types/types';
import {DefaultStore} from '@/utils/store';
import {ConnectToRemoteMessage, OnSendRtcDataMessage} from '@/types/messages';

export default abstract class AbstractPeerConnection extends MessageHandler {
  protected offerCreator: boolean = false;
  protected sendRtcDataQueue: OnSendRtcDataMessage[] = [];
  protected readonly opponentWsId: string;
  protected readonly connectionId: string;
  protected readonly logger: Logger;
  protected pc: RTCPeerConnection | null = null;
  protected connectionStatus: ConnectionStatus = 'new';
  protected webRtcUrl = WEBRTC_STUNT_URL;
  protected sdpConstraints: any;
  protected readonly wsHandler: WsHandler;
  protected readonly store: DefaultStore;
  protected readonly roomId: number;
  protected sendChannel: RTCDataChannel | null = null;

  protected abstract connectedToRemote: boolean;
  private readonly pc_config = {
    iceServers: [{
      url: this.webRtcUrl
    }]
  };
  private readonly pc_constraints: unknown = {
    optional: [/*Firefox*/
      /*{DtlsSrtpKeyAgreement: true},*/
      {RtpDataChannels: false /*true*/}
    ]
  };

  constructor(roomId: number, connectionId: string, opponentWsId: string, ws: WsHandler, store: DefaultStore) {
    super();
    this.roomId = roomId;
    this.connectionId = connectionId;
    this.opponentWsId = opponentWsId;
    sub.subscribe(Subscription.getPeerConnectionId(this.connectionId, this.opponentWsId), this);
    this.wsHandler = ws;
    this.store = store;
    this.logger = loggerFactory.getLogger(this.connectionId + ':' + this.opponentWsId, 'color: #960055');
    this.logger.debug('Created {}', this.constructor.name)();
  }

  public setConnectionStatus(newStatus: ConnectionStatus) {
    this.connectionStatus = newStatus;
    this.logger.log('Setting connection status to {}', newStatus)();
  }

  public getConnectionStatus() {
    return this.connectionStatus;
  }

  public onDestroy(reason?: string) {
    this.logger.log('Destroying {}, because {}', this.constructor.name, reason)();
    const message: RemovePeerConnection = {
      handler: Subscription.getTransferId(this.connectionId),
      action: 'removePeerConnection',
      opponentWsId: this.opponentWsId
    };
    sub.notify(message);
    sub.unsubscribe(Subscription.getPeerConnectionId(this.connectionId, this.opponentWsId));
  }

  public print(message: string) {
    this.logger.log('Call message {}', message)();
  }

  public createPeerConnection(arg?: ConnectToRemoteMessage) {
    this.logger.log('Creating RTCPeerConnection')();
    if (!window.RTCPeerConnection) {
      throw Error('Your browser doesn\'t support RTCPeerConnection');
    }

    this.pc = new (<any>RTCPeerConnection)(this.pc_config, this.pc_constraints);
    this.pc!.oniceconnectionstatechange = this.oniceconnectionstatechange.bind(this);
    this.pc!.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
      this.logger.log('onicecandidate')();
      if (event.candidate) {
        this.sendWebRtcEvent(event.candidate);
      }
    };
  }

  public abstract oniceconnectionstatechange(): void;

  public abstract ondatachannelclose(text: string): void;

  public closePeerConnection(text?: string) {
    this.setConnectionStatus('closed');
    if (this.pc && this.pc.signalingState !== 'closed') {
      this.logger.log('Closing peer connection')();
      this.pc.close();
    } else {
      this.logger.log('No peer connection to close')();
    }
  }

  public sendWebRtcEvent(message: RTCSessionDescriptionInit| RTCIceCandidate) {
    this.wsHandler.sendRtcData(message, this.connectionId, this.opponentWsId);
  }

  public failWebRtc(parent: string) {
    return (...args: unknown[]) => {
      const message = `An error occurred while ${parent}: ${extractError(args)}`;
      this.store.growlError(message);
      this.logger.error('failWebRtc {}', message)();
    };
  }

  public createOffer() { // each peer should be able to createOffer in case of microphone change
    this.logger.log('Creating offer...')();
    this.offerCreator = true;
    this.pc!.createOffer((offer: RTCSessionDescriptionInit) => {
      if (offer.sdp) {
        offer.sdp = this.setMediaBitrate(offer.sdp!, 1638400);
      }
      this.logger.log('Created offer, setting local description')();
      this.pc!.setLocalDescription(offer, () => {
        this.logger.log('Sending offer to remote')();
        this.sendWebRtcEvent(offer);
      },                           this.failWebRtc('setLocalDescription'));
    },                   this.failWebRtc('createOffer'), this.sdpConstraints);
  }

  public respondeOffer() {
    this.logger.log('Responding to offer')();
    this.offerCreator = false;
    this.pc!.createAnswer((answer: RTCSessionDescriptionInit) => {
      if (answer.sdp) {
        answer.sdp = this.setMediaBitrate(answer.sdp, 1638400);
      }
      this.logger.log('Sending answer')();
      this.pc!.setLocalDescription(answer, () => {
        this.sendWebRtcEvent(answer);
      }, this.failWebRtc('setLocalDescription'));
    }, this.failWebRtc('createAnswer') /*,this.sdpConstraints*/); // TODO wtf it that?
  }

  public setMediaBitrate(sdp: string, bitrate: number) {
    const lines = sdp.split('\n');
    let line = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].indexOf('m=') === 0) {
        line = i + 1;
        break;
      }
    }
    if (line === -1) {
      this.logger.log('Could not find the m line for {}', sdp)();

      return sdp;
    }
    // Skip i and c lines
    while (lines[line].indexOf('i=') === 0 || lines[line].indexOf('c=') === 0) {
      line++;
    }
    if (lines[line].indexOf('b') === 0) {
      this.logger.log('Replaced b line at line {}', line)();
      lines[line] = 'b=AS:' + bitrate;

      return lines.join('\n');
    } else {
      // Add a new b line
      this.logger.log('Adding new b line before line {}', line)();
      let newLines = lines.slice(0, line);
      newLines.push('b=AS:' + bitrate);
      newLines = newLines.concat(lines.slice(line, lines.length));

      return newLines.join('\n');
    }
  }

  public handleAnswer() {
    this.logger.log('Creating answer')();
    if (!this.offerCreator) {
      this.respondeOffer();
    }
    this.offerCreator = false;
  }

  protected onChannelMessage(event: MessageEvent) {
    this.logger.log('Received {} from webrtc data channel', bytesToSize(event.data.byteLength))();
  }

  protected onsendRtcData(message: OnSendRtcDataMessage) {
    if (!this.connectedToRemote) {
      this.logger.log('Connection is not accepted yet, pushing data to queue')();
      this.sendRtcDataQueue.push(message); 
      return;
    } else {
      const data: RTCSessionDescriptionInit | RTCIceCandidateInit | { message: unknown } = message.content;
      this.logger.log('onsendRtcData')();
      if (this.pc!.iceConnectionState && this.pc!.iceConnectionState !== 'closed') {
        if ((<RTCSessionDescriptionInit>data).sdp) {
          this.pc!.setRemoteDescription(
              new RTCSessionDescription(<RTCSessionDescriptionInit>data),
              this.handleAnswer.bind(this),
              this.failWebRtc('setRemoteDescription')
          );
        } else if ((<RTCIceCandidateInit>data).candidate) {
          this.pc!.addIceCandidate(new RTCIceCandidate(<RTCIceCandidateInit>data));
        } else if ((<{ message: unknown }>data).message) {
          this.logger.warn('Got unknow message {}', (<{ message: unknown }>data).message);
        }
      } else {
        this.logger.error('Skipping ws message for closed connection')();
      }
    }
  }

}
