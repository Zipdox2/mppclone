WebSocket.prototype.send = new Proxy(WebSocket.prototype.send, {
    apply: (target, thisArg, args) => {
        if (!args[0].startsWith(`[{"m":"hi"`)) args[0] = args[0].replace(localStorage.token, "[REDACTED]");
        return target.apply(thisArg, args);
    }
});

const rtcConfig = {
    iceServers: [
      {
        urls: 'stun:stun.l.google.com:19302'
      }
    ]
  }
  
  
class P2PConnection{
    constructor(iceCb, noteCb, closeCb){
        const self = this;

        this.conn = new RTCPeerConnection(rtcConfig);
        this.conn.onclose
        this.conn.createDataChannel('dummy'); // You need at least one track or channel to connect
        this.iceCb = iceCb;
        this.closeCb = closeCb;

        this.conn.onicecandidate = function(event){
            if(!event.candidate) return;
            if(typeof self.sendIceCandidates == 'object'){
                self.sendIceCandidates.push(event.candidate);
            }else{
                self.iceCb(event.candidate);
            }
        }
        function midiMsgCb(event){
            if(event.data.length < 11) return;
            const view = new DataView(event.data);

            const controlByte = view.getUint8(8);
            if(![0b100, 0b100].includes((controlByte >> 5))) return;
            const onOff = (controlByte >> 4) & 1;
            const channel = controlByte & 0b1111;
            const note = view.getUint8(9) & 0b1111111;
            const velocity = view.getUint8(10) & 0b1111111;

            const time = view.getFloat64(0);

            noteCb(time, onOff, channel, note, velocity);
        }
        this.conn.oniceconnectionstatechange = function(){
            if(self.conn.iceConnectionState == 'closed') return closeCb();
            if(['connected', 'completed'].includes(self.conn.iceConnectionState) && self.offering){
                self.midiChannel = self.conn.createDataChannel('midi');
                self.midiChannel.binaryType = "arraybuffer";
                self.midiChannel.onmessage = midiMsgCb;
                self.midiChannel.onclose = ()=>{closeCb()};
            }
        }
        this.conn.ondatachannel = function(event){
            if(event.channel.label != 'midi') return;
            self.midiChannel = event.channel;
            self.midiChannel.binaryType = "arraybuffer";
            self.midiChannel.onmessage = midiMsgCb;
            self.midiChannel.onclose = ()=>{closeCb()};

        }
        this.recIceCandidates = [];
        this.sendIceCandidates = [];
    }
  
    sendNote(time, onOff, channel, note, velocity){
        if(!this.midiChannel) return;
        if(this.midiChannel.readyState != 'open') return;
        const buf = new ArrayBuffer(11);
        const view = new DataView(buf);

        view.setFloat64(0, time);

        view.setUint8(8, 0b10000000 | ((onOff & 1) << 4) | (channel & 0b1111));
        view.setUint8(9, (note & 0b1111111));
        view.setUint8(10, (velocity & 0b1111111));

        this.midiChannel.send(buf);
    }

    close(){
        if(this.midiChannel) if(this.midiChannel.readyState != 'closed') this.midiChannel.close();
        this.conn.close();
    }

    async createOffer(){
        this.offering = true;
        const offer = await this.conn.createOffer();
        await this.conn.setLocalDescription(offer);
        return offer;
    }
  
    async createAnswer(offer){
        await this.conn.setRemoteDescription(offer);
        const answer = await this.conn.createAnswer();
        await this.conn.setLocalDescription(answer);
        while(this.recIceCandidates.length > 0){
            await this.conn.addIceCandidate(this.recIceCandidates.shift());
        }
        delete this.recIceCandidates;
        while(this.sendIceCandidates.length > 0){
            this.iceCb(this.sendIceCandidates.shift());
        }
        delete this.sendIceCandidates;
        return answer;
    }
    
    async acceptAnswer(answer){
        await this.conn.setRemoteDescription(answer);
        while(this.recIceCandidates.length > 0){
            await this.conn.addIceCandidate(this.recIceCandidates.shift());
        }
        delete this.recIceCandidates;
        while(this.sendIceCandidates.length > 0){
            this.iceCb(this.sendIceCandidates.shift());
        }
        delete this.sendIceCandidates;
    }
  
    async addIceCandidate(ice){
        if(typeof this.recIceCandidates == 'object'){
            this.recIceCandidates.push(ice);
        }else{
            await this.conn.addIceCandidate(ice);
        }
    }
}

class Client extends EventEmitter {
    constructor(uri, speedymppserver = false) {
        if (window.MPP && MPP.client) {
            throw new Error("Running multiple clients in a single tab is not allowed due to abuse. Attempting to bypass this may result in an auto-ban!")
        }
        super()

        this.speedymppserver = speedymppserver;
        this.uri = uri;
        this.ws = undefined;
        this.serverTimeOffset = 0;
        this.user = undefined;
        this.participantId = undefined;
        this.channel = undefined;
        this.ppl = {};
        this.connectionTime = undefined;
        this.connectionAttempts = 0;
        this.desiredChannelId = undefined;
        this.desiredChannelSettings = undefined;
        this.pingInterval = undefined;
        this.canConnect = false;
        this.noteBuffer = [];
        this.noteBufferTime = 0;
        this.noteFlushInterval = undefined;
        this.permissions = {};
        this['🐈'] = 0;
        this.loginInfo = undefined;

        this.bindEventListeners();

        this.emit("status", "(Offline mode)");
    }

    isSupported() {
        return typeof WebSocket === "function";
    };

    isConnected() {
        return this.isSupported() && this.ws && this.ws.readyState === WebSocket.OPEN;
    };

    isConnecting() {
        return this.isSupported() && this.ws && this.ws.readyState === WebSocket.CONNECTING;
    };

    start() {
        this.canConnect = true;
        if (!this.connectionTime) {
            this.connect();
        }
    };

    stop() {
        this.canConnect = false;
        this.ws.close();
    };

    connect() {
        if(!this.canConnect || !this.isSupported() || this.isConnected() || this.isConnecting())
            return;
        this.emit("status", "Connecting...");
        if(typeof module !== "undefined") {
            // nodejsicle
            this.ws = new WebSocket(this.uri, {
                origin: "https://www.multiplayerpiano.com"
            });
        } else {
            // browseroni
            this.ws = new WebSocket(this.uri);
        }
        var self = this;
        this.ws.addEventListener("close", function(evt) {
            self.user = undefined;
            self.participantId = undefined;
            self.channel = undefined;
            self.setParticipants([]);
            clearInterval(self.pingInterval);
            clearInterval(self.noteFlushInterval);

            self.emit("disconnect", evt);
            self.emit("status", "Offline mode");

            // reconnect!
            if(self.connectionTime) {
                self.connectionTime = undefined;
                self.connectionAttempts = 0;
            } else {
                ++self.connectionAttempts;
            }
            var ms_lut = [50, 2500, 10000];
            var idx = self.connectionAttempts;
            if(idx >= ms_lut.length) idx = ms_lut.length - 1;
            var ms = ms_lut[idx];
            setTimeout(self.connect.bind(self), ms);
        });
        this.ws.addEventListener("error", function(err) {
            self.emit("wserror", err);
            self.ws.close(); // self.ws.emit("close");
        });
        this.ws.addEventListener("open", function(evt) {
            self.pingInterval = setInterval(function() {
                self.sendPing();
            }, 20000);
            self.noteBuffer = [];
            self.noteBufferTime = 0;
            self.noteFlushInterval = setInterval(function() {
                if(self.noteBufferTime && self.noteBuffer.length > 0) {
                    self.sendArray([{m: "n", t: self.noteBufferTime + self.serverTimeOffset, n: self.noteBuffer}]);
                    self.noteBufferTime = 0;
                    self.noteBuffer = [];
                }
            }, 200);

            self.emit("connect");
            self.emit("status", "Joining channel...");
            if(self.speedymppserver){
                var hiMsg = {m:'hi'};
                hiMsg['🐈'] = self['🐈']++ || undefined;
                if (localStorage.token) {
                    hiMsg.token = localStorage.token;
                }
                self.sendArray([hiMsg])
            }
        });
        this.ws.addEventListener("message", async function(evt) {
            var transmission = JSON.parse(evt.data);
            for(var i = 0; i < transmission.length; i++) {
                var msg = transmission[i];
                self.emit(msg.m, msg);
            }
        });
    };

    bindEventListeners() {
        var self = this;
        this.on("hi", function(msg) {
            self.connectionTime = Date.now();
            self.user = msg.u;
            self.receiveServerTime(msg.t, msg.e || undefined);
            if(self.desiredChannelId) {
                self.setChannel();
            }
            if (msg.token) localStorage.token = msg.token;
            if (msg.permissions) {
                self.permissions = msg.permissions;
            } else {
                self.permissions = {};
            }
            if (msg.accountInfo) {
              self.accountInfo = msg.accountInfo;
            } else {
              self.accountInfo = undefined;
            }
        });
        this.on("t", function(msg) {
            self.receiveServerTime(msg.t, msg.e || undefined);
        });
        this.on("ch", function(msg) {
            self.desiredChannelId = msg.ch._id;
            self.desiredChannelSettings = msg.ch.settings;
            self.channel = msg.ch;
            if(msg.p) self.participantId = msg.p;
            self.setParticipants(msg.ppl);
        });
        this.on("p", function(msg) {
            self.participantUpdate(msg);
            self.emit("participant update", self.findParticipantById(msg.id));
        });
        this.on("m", function(msg) {
            if(self.ppl.hasOwnProperty(msg.id)) {
                self.participantMoveMouse(msg);
            }
        });
        this.on("bye", function(msg) {
            self.removeParticipant(msg.p);
        });
        this.on("b", function(msg) {
            if(self.speedymppserver) return;
            var hiMsg = {m:'hi'};
            hiMsg['🐈'] = self['🐈']++ || undefined;
            if (this.loginInfo) hiMsg.login = this.loginInfo;
            this.loginInfo = undefined;
            try {
                if (msg.code.startsWith('~')) {
                    hiMsg.code = Function(msg.code.substring(1))();
                } else {
                    hiMsg.code = Function(msg.code)();
                }
            } catch (err) {
                hiMsg.code = 'broken';
            }
            if (localStorage.token) {
                hiMsg.token = localStorage.token;
            }
            self.sendArray([hiMsg])
        });
        this.on("custom", function(msg){
            const self = this;

            if(typeof msg.data != 'object' || msg.data == null) return;
            if(typeof msg.data.d != 'object' || msg.data.d == null) return;
            if(!this.ppl.hasOwnProperty(msg.p)) return;
            const part = this.ppl[msg.p];
 
            switch(msg.data.t){
                case 'offer':
                    self.emit('offer', {
                        part,
                        accept: async function(){
                            if(!self.ppl.hasOwnProperty(msg.p)) return;
                            function iceCb(cand){
                                self.sendArray([{
                                    m: 'custom',
                                    target: {
                                        mode: 'id',
                                        id: msg.p,
                                    },
                                    data: {
                                        t: 'ice',
                                        d: cand
                                    }
                                }]);
                            }
                            function noteCb(time, onOff, channel, note, velocity){
                                self.emit("n", {
                                    p2p: true,
                                    m: 'n',
                                    t: time,
                                    p: msg.p,
                                    n: [{
                                        n: note,
                                        s: !onOff,
                                        v: velocity / 127
                                    }]
                                });
                            }
                            function closedCb(){
                                delete part.p2p;
                                self.emit('p2pclosed', part);
                            }
                            part.p2p = new P2PConnection(iceCb, noteCb, closedCb);
                            const answer = await part.p2p.createAnswer(msg.data.d);
                            self.sendArray([{
                                m: 'custom',
                                target: {
                                    mode: 'id',
                                    id: msg.p,
                                },
                                data: {
                                    t: 'answer',
                                    d: answer
                                }
                            }]);
                        }
                    });
                    break;
                case 'answer':
                    if(!part.p2p) return;
                    self.emit('answer', {
                        part,
                        accept: async function(){
                            if(!self.ppl.hasOwnProperty(msg.p)) return;
                            await part.p2p.acceptAnswer(msg.data.d);
                        }
                    });
                    break;
                case 'ice':
                    if(!part.p2p) return;
                    part.p2p.addIceCandidate(msg.data.d);
                    break;
                default:
                    return;
            }
        });
    };

    async requestP2P(id){
        if(!this.ppl.hasOwnProperty(id)) return;

        const self = this;
        const part = this.ppl[id];

        function iceCb(cand){
            self.sendArray([{
                m: 'custom',
                target: {
                    mode: 'id',
                    id,
                },
                data: {
                    t: 'ice',
                    d: cand
                }
            }]);
        }
        function noteCb(time, onOff, channel, note, velocity){
            self.emit("n", {
                p2p: true,
                m: 'n',
                t: time,
                p: id,
                n: [{
                    n: note,
                    s: !onOff,
                    v: velocity / 127
                }]
            });
        }
        function closedCb(){
            delete part.p2p;
            self.emit('p2pclosed', part);
        }
        part.p2p = new P2PConnection(iceCb, noteCb, closedCb);
        const offer = await part.p2p.createOffer();
        self.sendArray([{
            m: 'custom',
            target: {
                mode: 'id',
                id,
            },
            data: {
                t: 'offer',
                d: offer
            }
        }]);
    };

    async closeP2P(id){
        if(!this.ppl.hasOwnProperty(id)) return;
        const part = this.ppl[id];
        if(!part.p2p) return;
        part.p2p.close();
        delete part.p2p;
    };

    send(raw) {
        if(this.isConnected()) this.ws.send(raw);
    };

    sendArray(arr) {
        this.send(JSON.stringify(arr));
    };

    setChannel(id, set) {
        this.desiredChannelId = id || this.desiredChannelId || "lobby";
        this.desiredChannelSettings = set || this.desiredChannelSettings || undefined;
        this.sendArray([{m: "ch", _id: this.desiredChannelId, set: this.desiredChannelSettings}]);
    };

    offlineChannelSettings = {
        color:"#ecfaed"
    };

    getChannelSetting(key) {
        if(!this.isConnected() || !this.channel || !this.channel.settings) {
            return this.offlineChannelSettings[key];
        } 
        return this.channel.settings[key];
    };

    setChannelSettings(settings) {
        if(!this.isConnected() || !this.channel || !this.channel.settings) {
            return;
        } 
        if(this.desiredChannelSettings){
            for(var key in settings) {
                this.desiredChannelSettings[key] = settings[key];
            }
            this.sendArray([{m: "chset", set: this.desiredChannelSettings}]);
        }
    };

    offlineParticipant = {
        _id: "",
        name: "",
        color: "#777"
    };

    getOwnParticipant() {
        return this.findParticipantById(this.participantId);
    };

    setParticipants(ppl) {
        // remove participants who left
        for(var id in this.ppl) {
            if(!this.ppl.hasOwnProperty(id)) continue;
            var found = false;
            for(var j = 0; j < ppl.length; j++) {
                if(ppl[j].id === id) {
                    found = true;
                    break;
                }
            }
            if(!found) {
                this.removeParticipant(id);
            }
        }
        // update all
        for(var i = 0; i < ppl.length; i++) {
            this.participantUpdate(ppl[i]);
        }
    };

    countParticipants() {
        var count = 0;
        for(var i in this.ppl) {
            if(this.ppl.hasOwnProperty(i)) ++count;
        }
        return count;
    };

    participantUpdate(update) {
        var part = this.ppl[update.id] || null;
        if(part === null) {
            part = update;
            this.ppl[part.id] = part;
            this.emit("participant added", part);
            this.emit("count", this.countParticipants());
        } else {
            Object.keys(update).forEach(key => {
                part[key] = update[key];
            });
            if (!update.tag) delete part.tag;
            if (!update.vanished) delete part.vanished;
        }
    };

    participantMoveMouse(update) {
        var part = this.ppl[update.id] || null;
        if(part !== null) {
            part.x = update.x;
            part.y = update.y;
        }
    };

    removeParticipant(id) {
        if(this.ppl.hasOwnProperty(id)) {
            var part = this.ppl[id];
            if(part.p2p) part.p2p.close();
            delete this.ppl[id];
            this.emit("participant removed", part);
            this.emit("count", this.countParticipants());
        }
    };

    findParticipantById(id) {
        return this.ppl[id] || this.offlineParticipant;
    };

    isOwner() {
        return this.channel && this.channel.crown && this.channel.crown.participantId === this.participantId;
    };

    preventsPlaying() {
        return this.isConnected() && !this.isOwner() && this.getChannelSetting("crownsolo") === true && !this.permissions.playNotesAnywhere;
    };

    receiveServerTime(time, echo) {
        var self = this;
        var now = Date.now();
        var target = time - now;
        // console.log("Target serverTimeOffset: " + target);
        var duration = 1000;
        var step = 0;
        var steps = 50;
        var step_ms = duration / steps;
        var difference = target - this.serverTimeOffset;
        var inc = difference / steps;
        var iv;
        iv = setInterval(function() {
            self.serverTimeOffset += inc;
            if(++step >= steps) {
                clearInterval(iv);
                // console.log("serverTimeOffset reached: " + self.serverTimeOffset);
                self.serverTimeOffset=target;
            }
        }, step_ms);
        // smoothen

        // this.serverTimeOffset = time - now;            // mostly time zone offset ... also the lags so todo smoothen this
                                    // not smooth:
        // if(echo) this.serverTimeOffset += echo - now;    // mostly round trip time offset
    };

    startNote(note, vel, midiNote) {
        for(let userId in this.ppl){
            let user = this.ppl[userId]
            if(user.p2p) user.p2p.sendNote(Date.now() / 1000, 1, 0, midiNote, Math.round((vel ?? 0.5) * 127));
        }
        if (typeof note !== 'string') return;
        if(this.isConnected()) {
            var vel = typeof vel === "undefined" ? undefined : +vel.toFixed(3);
            if(!this.noteBufferTime) {
                this.noteBufferTime = Date.now();
                this.noteBuffer.push({n: note, v: vel});
            } else {
                this.noteBuffer.push({d: Date.now() - this.noteBufferTime, n: note, v: vel});
            }
        }
    };

    stopNote(note, midiNote) {
        if (typeof note !== 'string') return;
        for(let userId in this.ppl){
            let user = this.ppl[userId]
            if(user.p2p) user.p2p.sendNote(Date.now() / 1000, 0, 0, midiNote, 0);
        }
        if(this.isConnected()) {
            if(!this.noteBufferTime) {
                this.noteBufferTime = Date.now();
                this.noteBuffer.push({n: note, s: 1});
            } else {
                this.noteBuffer.push({d: Date.now() - this.noteBufferTime, n: note, s: 1});
            }
        }
    };

    sendPing() {
        var msg = {m: "t", e: Date.now()};
        this.sendArray([msg]);
    };

    setLoginInfo(loginInfo) {
      this.loginInfo = loginInfo;
    };
};

this.Client = Client;
