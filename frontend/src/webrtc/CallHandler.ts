import BaseTransferHandler from '@/webrtc/BaseTransferHandler';
import {
  AcceptCallMessage, CallStatus,
  ConnectToRemoteMessage,
  DefaultMessage,
  OfferCall,
  ReplyCallMessage, ScreenShareData,
  WebRtcSetConnectionIdMessage
} from '@/types/messages';
import {browserVersion, isChrome, isMobile} from '@/utils/singletons';
import {sub} from '@/utils/sub';
import Subscription from '@/utils/Subscription';
import {CallsInfoModel, IncomingCallModel} from '@/types/model';
import {
  BooleanIdentifier,
  ChangeStreamMessage,
  JsAudioAnalyzer, MediaIdentifier,
  NumberIdentifier,
  SetDevices,
  StringIdentifier, VideoType
} from '@/types/types';
import {CHROME_EXTENSION_ID, CHROME_EXTENSION_URL} from '@/utils/consts';
import {extractError, getChromeVersion} from '@/utils/utils';
import {
  createMicrophoneLevelVoice,
  getAverageAudioLevel
} from '@/utils/audioprocc';
import CallSenderPeerConnection from '@/webrtc/CallSenderPeerConnection';
import CallReceiverPeerConnection from '@/webrtc/CallReceiverPeerConnection';
import router from '@/utils/router';
import {forEach} from '@/utils/htmlApi';
import {HandlerType, HandlerTypes} from '@/utils/MesageHandler';

export default class CallHandler extends BaseTransferHandler {

  private get callInfo(): CallsInfoModel {
    return this.store.roomsDict[this.roomId].callInfo;
  }
  protected readonly handlers: HandlerTypes = {
    answerCall: this.answerCall,
    videoAnswerCall: this.videoAnswerCall,
    declineCall: this.declineCall,
    replyCall: <HandlerType>this.replyCall,
    acceptCall: <HandlerType>this.onacceptCall,
    removePeerConnection: <HandlerType>this.removePeerConnection
  };
  private localStream: MediaStream | null = null;
  private audioProcessor: JsAudioAnalyzer | null = null;
  private callStatus: CallStatus = 'not_inited';
  private readonly acceptedPeers: string[] = [];

  public inflateDevices(devices: MediaDeviceInfo[]): void {
    let n: number, k: number, c: number = 0;
    const microphones: { [id: string]: string } = {};
    const speakers: { [id: string]: string } = {};
    const webcams: { [id: string]: string } = {};
    const payload: SetDevices = {
      microphones,
      webcams,
      speakers
    };
    if (devices) {
      devices.forEach((device: MediaDeviceInfo) => {
        switch (device.kind) {
          case 'audioinput':
            microphones[device.deviceId] = device.label || 'Microphone ' + (++n);
            break;
          case 'audiooutput':
            speakers[device.deviceId] = device.label || 'Speaker ' + (++k);
            break;
          case 'videoinput':
            webcams[device.deviceId] = device.label || 'Camera ' + (++c);
        }
      });
    }
    this.store.setDevices(payload);
  }

  public onacceptCall(message: AcceptCallMessage) {
    if (this.callStatus !== 'received_offer') { // if we're call initiator
      if (!this.connectionId) {
        throw Error('Conn is is null');
      }
      const payload: ConnectToRemoteMessage = {
        action: 'connectToRemote',
        handler: Subscription.getPeerConnectionId(this.connectionId, message.opponentWsId),
        stream: this.localStream
      };
      sub.notify(payload);
    } else {
      this.acceptedPeers.push(message.opponentWsId);
    }
  }

  public async getDesktopShareFromExtension(): Promise<string> {
    if (!isChrome) {
      throw new Error('ScreenCast feature is only available from chrome atm');
    } else if (isMobile) {
      throw new Error('ScreenCast is not available for mobile phones yet');
    } else {
      await this.pingExtension();
      this.logger.log('Ping to extension succeeded')();
      const response = await new Promise<{streamId: string; data: string}>((resolve, reject) => {
        chrome.runtime.sendMessage(CHROME_EXTENSION_ID, {type: 'PYCHAT_SCREEN_SHARE_REQUEST'}, resolve);
      });
      if (response && response.data === 'success') {
        this.logger.log('Getting desktop share succeeded')();

        return response.streamId;
      } else {
        throw new Error('Failed to capture desktop stream');
      }
    }
  }

  public async captureInput(): Promise<MediaStream> {
    let endStream;
    this.logger.debug('capturing input')();
    if (this.callInfo.showMic || this.callInfo.showVideo) {
      let audio: any = this.callInfo.showMic;
      if (this.callInfo.currentMic && audio) {
        audio = {deviceId: this.callInfo.currentMic};
      }
      let video: any = this.callInfo.showVideo; // convert null to bolean, if we pass null to getUserMedia it tries to capture
      if (this.callInfo.currentWebcam && video) {
        video = {deviceId: this.callInfo.currentWebcam};
      }
      endStream = await navigator.mediaDevices.getUserMedia({audio, video});
      this.logger.debug('navigator.mediaDevices.getUserMedia({audio, video})')();
      if (navigator.mediaDevices.enumerateDevices) {
        const devices: MediaDeviceInfo[] = await navigator.mediaDevices.enumerateDevices();
        this.inflateDevices(devices);
      }
    }
    if (this.callInfo.shareScreen) {
      let stream;
      const chromeVersion = getChromeVersion();
      if (navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) {
        this.logger.debug('Getting shareScreen from  navigator.getDisplayMedia')();
        stream = await navigator.mediaDevices.getDisplayMedia({video: true});
      } else {
        if (chromeVersion && chromeVersion > 70) {
          this.store.growlInfo('You can now use chrome://flags/#enable-experimental-web-platform-features to share your screen');
        }
        const streamId: string = await this.getDesktopShareFromExtension();
        this.logger.debug('Resolving userMedia from dekstopShare')();
        stream = await navigator.mediaDevices.getUserMedia(<MediaStreamConstraints><unknown>{ // TODO update ts to support this
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: streamId,
              maxWidth: window.screen.width,
              maxHeight: window.screen.height
            }
          }
        });
      }
      const tracks: any[] = stream.getVideoTracks();
      if (!(tracks && tracks.length > 0)) {
        throw Error('No video tracks from captured screen');
      }
      tracks[0].isShare = true;
      if (endStream) {
        endStream.addTrack(tracks[0]);
      } else {
        endStream = stream;
      }
    }
    if (!endStream) {
      throw new Error('Unable to capture stream');
    }

    return endStream;
  }

  public processAudio(audioProc: JsAudioAnalyzer) {
    return () => {
      if (!this.callInfo.showMic) {
        return;
      }
      if (audioProc.volumeValuesCount < 101) {
        audioProc.prevVolumeValues += getAverageAudioLevel(audioProc);
        audioProc.volumeValuesCount++;
        if (audioProc.volumeValuesCount === 100 && audioProc.prevVolumeValues === 0) {
          let url = isChrome ? 'setting in chrome://settings/content' : 'your browser settings';
          url += navigator.platform.indexOf('Linux') >= 0 ?
              '. Open pavucontrol for more info' :
              ' . Right click on volume icon in system tray -> record devices -> input -> microphone';
          this.store.growlError(`Unable to capture input from microphone. Check your microphone connection or ${url}`);
        }
      }
      const payload: NumberIdentifier = {
        id: this.roomId,
        state: Math.sqrt(getAverageAudioLevel(audioProc))
      };
      this.store.setCurrentMicLevel(payload);
    };
  }

  public async toggleDevice(videoType: VideoType) {
    const track = this.getTrack(videoType);
    if (track && track.readyState === 'live') {
      this.logger.log('toggleDevice')();
      let state = false;
      if (videoType === VideoType.AUDIO) {
        state = this.callInfo.showMic;
      } else if (videoType === VideoType.SHARE) {
        state = this.callInfo.shareScreen;
      } else if (videoType === VideoType.VIDEO) {
        state = this.callInfo.showVideo;
      }
      track.enabled = state;
    } else {
      await this.updateConnection();
    }
  }

  public async updateConnection() {
    this.logger.log('updateConnection')();
    let stream: MediaStream|null = null;
    if (this.localStream && this.localStream.active) {
      try {
        stream = await this.captureInput();
        this.stopLocalStream();
        this.attachLocalStream(stream);

        this.webrtcConnnectionsIds.forEach(pcName => {
          const message: ChangeStreamMessage = {
            handler: Subscription.getPeerConnectionId(this.connectionId!, pcName),
            action: 'streamChanged',
            newStream: stream!,
            oldStream: this.localStream!
          };
          sub.notify(message);
        });
      } catch (e) {
        this.handleStream(e, stream);
      }
    }
  }

  public getTrack(kind: VideoType) {
    let track = null;
    let tracks = [];
    if (this.localStream) {
      if (kind === VideoType.VIDEO || kind === VideoType.SHARE) {
        tracks = this.localStream.getVideoTracks();
      } else if (kind === VideoType.AUDIO) {
        tracks = this.localStream.getAudioTracks();
      } else {
        throw Error('invalid track name');
      }
      if (tracks.length > 0) {
        const isShare = tracks[0].isShare;
        if (isShare && kind === VideoType.SHARE) {
          track = tracks[0];
        } else if (!isShare && kind === VideoType.VIDEO) {
          track = tracks[0];
        } else if (kind === VideoType.AUDIO) {
          track = tracks[0];
        }
      }
    }

    return track;
  }

  // setAudio(value) {
  //   let audioTrack = this.getTrack('audio');
  //   if (!audioTrack) {
  //     let payload: BooleanIdentifier = {
  //       id: this.roomId,
  //       state: false,
  //     };
  //     this.store.setMicToState(payload);
  //   }
  // }

  public setCallIconsState() {
    // if (this.callInfo.showMic) {
    //   let audioTrack = this.getTrack('audio');
    //   if (!audioTrack) {
    //     let payload: BooleanIdentifier = {
    //       id: this.roomId,
    //       state: false,
    //     }
    //     this.store.setMicToState(payload);
    //   }
    // }
    // let videoTrack = this.getTrack('video');
    // if (this.)
    // this.setVideo(videoTrack && videoTrack.enabled);
    // this.setAudio(audioTrack && audioTrack.enabled);
    // this.setDesktopCapture(this.getTrack('share') != null);
    // this.autoSetLocalVideoVisibility();
  }

  public async offerCall() {
    let stream: MediaStream | null = null;
    try {
      stream = await this.captureInput();
      this.logger.log('got local stream {}', stream)();
      if (stream) {
        this.attachLocalStream(stream);
      }
      const payload: BooleanIdentifier = {
        state: true,
        id: this.roomId
      };
      this.setCallStatus('sent_offer');
      this.store.setCallActiveToState(payload);
      this.wsHandler.offerCall(this.roomId, browserVersion, (e: WebRtcSetConnectionIdMessage) => {
        if (e.connId) {
          this.connectionId = e.connId;
          sub.subscribe(Subscription.getTransferId(e.connId), this);
        }
      });
    } catch (e) {
      this.handleStream(e, stream);
    }
  }

  public createCallPeerConnection(message: ReplyCallMessage) {
    if (message.opponentWsId > this.wsHandler.getWsConnectionId()) {
      new CallSenderPeerConnection(this.roomId, this.connectionId!, message.opponentWsId, message.userId, this.wsHandler, this.store);
    } else {
      new CallReceiverPeerConnection(this.roomId, this.connectionId!, message.opponentWsId, message.userId, this.wsHandler, this.store);
    }
    this.webrtcConnnectionsIds.push(message.opponentWsId);
  }

  public replyCall(message: ReplyCallMessage) {
    this.createCallPeerConnection(message);
  }

  public initAndDisplayOffer(message: OfferCall) {
    this.setCallStatus('received_offer');
    if (this.connectionId) {
      this.logger.error('Old connId still exists {}', this.connectionId)();
    }
    this.connectionId = message.connId;
    sub.subscribe(Subscription.getTransferId(message.connId), this);
    this.logger.log('CallHandler initialized')();
    this.wsHandler.replyCall(message.connId, browserVersion);
    const payload2: IncomingCallModel = {
      connId: message.connId,
      roomId: message.roomId,
      userId: message.userId
    };
    this.acceptedPeers.push(message.opponentWsId);
    this.store.setIncomingCall(payload2);
    this.createCallPeerConnection(message);
  }

  public answerCall() {
    this.doAnswer(false);
  }

  public async doAnswer(withVideo: boolean) {
    const trueBoolean: BooleanIdentifier = {
      state: true,
      id: this.roomId
    };
    const falseBoolean: BooleanIdentifier = {
      state: false,
      id: this.roomId
    };
    this.store.setIncomingCall(null);
    this.store.setCallActiveToState(trueBoolean);
    this.store.setContainerToState(trueBoolean);
    this.store.setVideoToState(withVideo ? trueBoolean : falseBoolean);
    this.store.setMicToState(trueBoolean);
    this.setCallStatus('accepted');
    const stream = await this.captureInput();
    this.attachLocalStream(stream);
    this.wsHandler.acceptCall(this.connectionId!);
    this.acceptedPeers.forEach((e) => {
      const message: ConnectToRemoteMessage = {
        action: 'connectToRemote',
        stream: this.localStream,
        handler: Subscription.getPeerConnectionId(this.connectionId!, e)
      };
      sub.notify(message);
    });
    router.replace(`/chat/${this.roomId}`);
  }

  public videoAnswerCall() {
    this.doAnswer(true);
  }

  public destroyAudioProcessor() {
    if (this.audioProcessor && this.audioProcessor.javascriptNode && this.audioProcessor.javascriptNode.onaudioprocess) {
      this.logger.debug('Removing local audioproc')();
      this.audioProcessor.javascriptNode.onaudioprocess = null;
    }
  }

  public stopLocalStream() {
    this.destroyAudioProcessor();
    this.destroyStreamData(this.localStream);
  }

  public onDestroy() {
    this.stopLocalStream();
    const payload2: MediaIdentifier = {
      id: this.roomId,
      media: null
    };
    this.store.setLocalStreamSrc(payload2);
    this.connectionId = null;
    const payload: BooleanIdentifier = {
      state: false,
      id: this.roomId
    };
    this.store.setCallActiveToState(payload);
  }

  public declineCall() {
    this.store.setIncomingCall(null);
    this.wsHandler.declineCall(this.connectionId!);
    this.onDestroy();
  }

  public hangCall() {
    this.logger.debug('on hangCall called')();
    const hadConnections = this.webrtcConnnectionsIds.length > 0;
    if (hadConnections) {
      this.closeAllPeerConnections();
    } else {
      this.onDestroy();
    }
  }

  private async pingExtension(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const error = {rawError: `To share your screen you need chrome extension.<b> <a href="${CHROME_EXTENSION_URL}" target="_blank">Click to install</a></b>`};
      if (chrome.runtime && chrome.runtime.sendMessage) {
        let triggered = false;
        const timedCB = setTimeout(function () {
          !triggered && reject(error);
          triggered = true;
        },                         500);

        chrome.runtime.sendMessage(CHROME_EXTENSION_ID, {
          type: 'PYCHAT_SCREEN_SHARE_PING'
        },                         (response) => {
          if (triggered) {
            this.logger.error('extension responded after timeout')();
          } else if (response && response.data === 'success') {
            clearTimeout(timedCB);
            resolve();
          } else {
            clearTimeout(timedCB);
            reject(response && response.data || error);
          }
        });
      } else {
        reject(error);
      }
    });

  }

  private handleStream(e: string, endStream: MediaStream|null) {
    const what = [];
    if (this.callInfo.showMic) {
      what.push('audio');
    }
    if (this.callInfo.showVideo) {
      what.push('video');
    }
    if (this.callInfo.shareScreen) {
      what.push('screenshare');
    }
    const message = `<span>Failed to capture ${what.join(', ')} source</span>, because ${extractError(e)}`;
    this.destroyStreamData(endStream);
    this.store.growlErrorRaw(message);
    this.logger.error('onFailedCaptureSource {}', e)();
  }

  private destroyStreamData(endStream: MediaStream|null) {
    if (endStream) {
      const tracks: MediaStreamTrack[] = endStream.getTracks();
      if (tracks) {
        tracks.forEach(e => e.stop());
      }
    }
  }

  private attachLocalStream(stream: MediaStream) {
    this.logger.log('Local stream has been attached');
    if (stream) {
      this.localStream = stream;
      this.audioProcessor = createMicrophoneLevelVoice(stream, this.processAudio.bind(this));
      const payload: MediaIdentifier = {
        id: this.roomId,
        media: stream
      };
      this.store.setLocalStreamSrc(payload);
    }
    this.setCallIconsState();
  }

  private setCallStatus(status: CallStatus) {
    this.logger.log('Setting call status to {}', status)();
    this.callStatus = status;
  }
}
