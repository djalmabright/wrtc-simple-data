import wrtc from 'wrtc';
import SocketIoClient from 'socket.io-client';
import freeice from 'freeice';
export default class Connection {
    constructor(opts = {}) {
        this.configureSocketIO = () => {
            this.socket.on('connect', () => {
                this.socket.emit('join', this.room);
                this.debug('Sent request to join room ' + this.room);
                this.socket.on('created', (id) => {
                    this.debug('Created new room ' + this.room);
                });
                this.socket.on('joined', (data) => {
                    this.myId = data.id;
                    for (let i = -1; i < data.peers.length; i++) {
                        if (data.peers[i] !== this.myId) {
                            this.createConnection(data.peers[i], false);
                        }
                    }
                    this.debug('Successfully joined room ' + this.room);
                    const ready = 'ready';
                    if (this._callbacks[ready]) {
                        this._callbacks[ready]();
                    }
                });
                this.socket.on('new peer', (id) => {
                    this.debug('New peer has joined the room');
                    const pc = this.createConnection(id, true);
                    this.callPeer(pc);
                });
                this.socket.on('data', (data) => {
                    switch (data.type) {
                        case 'offer':
                            this.debug('Got an offer from ' + data.from);
                            this.onOffer(data, this.pcMap[data.from]);
                            break;
                        case 'answer':
                            this.debug('Got an answer from ' + data.from);
                            this.onAnswer(data, this.pcMap[data.from]);
                            break;
                        case 'candidate':
                            this.debug('Got a candidate: ' + data.id);
                            this.onCandidate(data.candidate, this.pcMap[data.id]);
                            break;
                        default:
                            this.debug(`Got an unexpected data type:'${data.type}'`);
                    }
                });
            });
        };
        this.createConnection = (id, create) => {
            const pc = new wrtc.RTCPeerConnection(this.options.rtcOpts);
            pc.id = id;
            this.debug('Created peer connection ' + id);
            if (create)
                this.createDataChannel(pc);
            else
                pc.ondatachannel = (event) => {
                    this.onDataChannel(event, pc);
                };
            pc.onicecandidate = (event) => {
                this.handleIceCandidate(event, pc);
            };
            this.pcMap[id] = pc;
            return pc;
        };
        this.createDataChannel = (peerconnection) => {
            const dataChannel = peerconnection.createDataChannel(this.options.channelName, this.options.channelOpts);
            dataChannel.remotePeer = peerconnection;
            this.dataChannels.push(dataChannel);
            this.setDataChannelCallbacks(dataChannel);
            this.debug('Created data channel with peer ' + peerconnection.id);
        };
        this.callPeer = (pc) => {
            pc.createOffer((description) => {
                description.from = this.myId;
                description.to = pc.id;
                this.setLocalDescription(description, pc);
            }, console.log);
            this.debug('Created offer for peer ' + pc.id);
        };
        this.onOffer = (description, pc) => {
            pc.setRemoteDescription(new wrtc.RTCSessionDescription(description));
            this.debug('Set remote description for peer ' + pc.id);
            /* tslint:disable:no-shadowed-variable */
            pc.createAnswer((description) => {
                description.from = this.myId;
                description.to = pc.id;
                this.setLocalDescription(description, pc);
            }, console.log);
        };
        this.onAnswer = (description, pc) => {
            pc.setRemoteDescription(new wrtc.RTCSessionDescription(description));
            this.debug('Set remote description for peer ' + description.from);
        };
        this.setLocalDescription = (description, pc) => {
            pc.setLocalDescription(description);
            this.debug('Set local description for ' + pc.id + ' and sent offer / answer.');
            this.socket.emit('data', description);
        };
        this.handleIceCandidate = (event, pc) => {
            if (pc.candidateSent || !event.candidate)
                return;
            const candidate = event.candidate;
            this.socket.emit('data', {
                type: 'candidate',
                candidate: candidate,
                id: this.myId,
            });
            this.debug('Broadcasted candidate: ' + pc.id);
            pc.candidateSent = true;
        };
        this.onCandidate = (candidate, pc) => {
            if (!candidate)
                return;
            pc.addIceCandidate(new wrtc.RTCIceCandidate({
                sdpMLineIndex: candidate.sdpMLineIndex,
                sdpMid: candidate.sdpMid,
                candidate: candidate.candidate,
            }));
            this.debug('Added received candidate ' + pc.id);
        };
        this.setDataChannelCallbacks = (dataChannel) => {
            dataChannel.onopen = () => {
                this.handleDataChannelState(dataChannel);
            };
            dataChannel.onclose = () => {
                this.handleDataChannelState(dataChannel);
            };
            dataChannel.onmessage = (event) => {
                this.onMessage(event, dataChannel);
            };
            this.debug('Set the data channel callback.');
        };
        this.handleDataChannelState = (dataChannel) => {
            const state = dataChannel.readyState;
            this.debug('Channel is ' + state);
            if (this._callbacks['channel:ready'] && state === 'open') {
                this._callbacks['channel:ready']();
            }
            else if (this._callbacks['channel:notready'] && state !== 'open') {
                this._callbacks['channel:notready']();
            }
        };
        this.onDataChannel = (event, pc) => {
            const dataChannel = event.channel;
            dataChannel.remotePeer = pc;
            this.dataChannels.push(dataChannel);
            this.setDataChannelCallbacks(dataChannel);
        };
        this.onMessage = (event, dc) => {
            this.debug('[Message] ' + event.data);
            const message = 'message';
            if (this._callbacks[message]) {
                this._callbacks[message]({
                    text: event.data,
                    sender: dc.remotePeer.id
                });
            }
        };
        this.on = (event, callback) => {
            this._callbacks[event] = callback;
        };
        this.sendMessage = (message) => {
            this.dataChannels.forEach(function (channel) {
                channel.send(message);
            });
            this.debug('Sent message');
        };
        this.close = () => {
            Object.keys(this.pcMap).forEach((id) => {
                this.pcMap[id].close();
            });
            this.socket.close();
        };
        this.options = {
            signallingServer: opts.signallingServer || 'http://localhost:3000/',
            roomName: opts.roomName || 'defaultRoom',
            rtcOpts: opts.rtcOpts || { iceServers: freeice() },
            channelName: opts.channelName || 'messages',
            channelOpts: opts.channelOpts || { reliable: false },
            debugMode: opts.debugMode || false
        };
        this.debug = (this.options.debugMode ?
            function (msg) {
                return console.log('[DEBUG] ' + msg);
            } :
            function (msg) {
                return undefined;
            });
        this.socket = SocketIoClient(this.options.signallingServer);
        this.myId = undefined;
        this.pcMap = {};
        this.dataChannels = [];
        this.room = this.options.roomName;
        this._callbacks = {};
        this.debug('debug enabled');
        this.configureSocketIO();
    }
}
//# sourceMappingURL=Connection.js.map