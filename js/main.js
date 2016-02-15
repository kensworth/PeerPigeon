'use strict';
/****************************************************************************
 * Initial setup
 ****************************************************************************/

var configuration = {
  'iceServers': [
    {'url': 'stun:stun.l.google.com:19302'}
  ]
};

roomURL = document.getElementById('url'),
remoteVideo = document.getElementById('remoteVideo'),
localVideo = document.getElementById('localVideo'),
trail = document.getElementById('trail'),
chatInner = document.getElementById('chatInner'),
messageInput = document.getElementById('text'),
sendTextBtn = document.getElementById('sendText');

sendTextBtn.addEventListener('click', sendText);
messageInput.addEventListener("keydown", onMessageKeyDown);

var isChannelReady;
var isInitiator = false;
var isStarted = false;
var localStream;
var pc;
var remoteStream;
var turnReady;

var pc_config = {
  //insert twilio turn
};

var pc_constraints = {'optional': [{'DtlsSrtpKeyAgreement': true}]};

// Set up audio and video regardless of what devices are present.
var sdpConstraints = {'mandatory': {
  'OfferToReceiveAudio':true,
  'OfferToReceiveVideo':true }};

/****************************************************************************
 * Signaling server 
 ****************************************************************************/

var room = window.location.hash;
if (!room) {
  serverMessage('You\'ve connected to an empty room. Please enter a room name below.');
}

var socket = io.connect();

if (room) {
  console.log('Create or join room', room);
  console.log(room);
  socket.emit('create or join', room);
}

socket.on('ipaddr', function (ipaddr) {
    console.log('Server IP address is: ' + ipaddr);
    updateRoomURL(ipaddr);
});

socket.on('created', function (room){
  console.log('Created room ' + room);
  isInitiator = true;
  serverMessage('Success! Room created at ' + location.href + room);
});

socket.on('full', function (roomName){
  console.log('Room ' + roomName + ' is full');
  serverMessage('This room is full, please enter a different room name below.');
  room = null;
});

socket.on('join', function (room){
  console.log('Another peer made a request to join room ' + room);
  console.log('This peer is the initiator of room ' + room + '!');
  isChannelReady = true;
});

socket.on('joined', function (room){
  console.log('This peer has joined room ' + room);
  isChannelReady = true;
  serverMessage('Success! Joined room at ' + window.location.hostname + '/' + room);
});

socket.on('log', function (array){
  console.log.apply(console, array);
});

if (location.hostname.match(/localhost|127\.0\.0/)) {
  socket.emit('ipaddr');
}

/****************************************************************************
 * Server Messaging
 ****************************************************************************/

function sendMessage(message){
    console.log('Client sending message: ', message);
  // if (typeof message === 'object') {
  //   message = JSON.stringify(message);
  // }
  socket.emit('message', message);
}

socket.on('message', function (message){
  console.log('Client received message:', message);
  if (message === 'got user media') {
    maybeStart();
  } else if (message.type === 'offer') {
    if (!isInitiator && !isStarted) {
      maybeStart();
    }
    pc.setRemoteDescription(new RTCSessionDescription(message));
    doAnswer();
  } else if (message.type === 'answer' && isStarted) {
    pc.setRemoteDescription(new RTCSessionDescription(message));
  } else if (message.type === 'candidate' && isStarted) {
    var candidate = new RTCIceCandidate({
      sdpMLineIndex: message.label,
      candidate: message.candidate
    });
    pc.addIceCandidate(candidate);
  } else if (message === 'bye' && isStarted) {
    handleRemoteHangup();
  }
});

/**************************************************************************** 
 * User media (webcam) 
 ****************************************************************************/

function handleUserMedia(stream) {
  console.log('Adding local stream.');
  localVideo.src = window.URL.createObjectURL(stream);
  localStream = stream;
  sendMessage('got user media');
  if (isInitiator) {
    maybeStart();
  }
}

function handleUserMediaError(error){
  console.log('getUserMedia error: ', error);
}

var constraints = {video: true, audio: true};
getUserMedia(constraints, handleUserMedia, handleUserMediaError);

console.log('Getting user media with constraints', constraints);

/*if (location.hostname != "localhost") {
  requestTurn('');
}*/

function maybeStart() {
  if (!isStarted && typeof localStream != 'undefined' && isChannelReady) {
    createPeerConnection();
    pc.addStream(localStream);
    isStarted = true;
    console.log('isInitiator', isInitiator);
    if (isInitiator) {
      doCall();
    }
  }
}

window.onbeforeunload = function(e){
    sendMessage('bye');
}

/**************************************************************************** 
 * WebRTC peer connection and data channel
 ****************************************************************************/
var dataChannel;

function onLocalSessionCreated(desc) {
    console.log('local session created:', desc);
    peerConn.setLocalDescription(desc, function () {
        console.log('sending local desc:', peerConn.localDescription);
        sendMessage(peerConn.localDescription);
    }, logError);
}

function onDataChannelCreated(channel) {
    console.log('onDataChannelCreated:', channel);

    channel.onopen = function () {
        console.log('channel opened!');
    };

    channel.onmessage = function(message) {
        addMessage(message);
    }
}

function createPeerConnection() {
  try {
    pc = new RTCPeerConnection(configuration);
    pc.onicecandidate = handleIceCandidate;
    pc.onaddstream = handleRemoteStreamAdded;
    pc.onremovestream = handleRemoteStreamRemoved;
    if (isInitiator) {
        console.log('Creating Data Channel');
        dataChannel = pc.createDataChannel("media");
        onDataChannelCreated(dataChannel);

        console.log('Creating an offer');
        pc.createOffer(onLocalSessionCreated, logError);
    } else {
        pc.ondatachannel = function (event) {
            console.log('ondatachannel:', event.channel);
            dataChannel = event.channel;
            onDataChannelCreated(dataChannel);
        };
    }
    console.log('Created RTCPeerConnnection');
  } catch (e) {
    console.log('Failed to create PeerConnection, exception: ' + e.message);
    console.log('Cannot create RTCPeerConnection object.');
      return;
  }
}

function handleIceCandidate(event) {
  console.log('handleIceCandidate event: ', event);
  if (event.candidate) {
    sendMessage({
      type: 'candidate',
      label: event.candidate.sdpMLineIndex,
      id: event.candidate.sdpMid,
      candidate: event.candidate.candidate});
  } else {
    console.log('End of candidates.');
  }
}

function handleRemoteStreamAdded(event) {
  console.log('Remote stream added.');
  remoteVideo.src = window.URL.createObjectURL(event.stream);
  remoteStream = event.stream;
}

function handleCreateOfferError(event){
  console.log('createOffer() error: ', e);
}

function doCall() {
  console.log('Sending offer to peer');
  pc.createOffer(setLocalAndSendMessage, handleCreateOfferError);
}

function doAnswer() {
  console.log('Sending answer to peer.');
  pc.createAnswer(setLocalAndSendMessage, null, sdpConstraints);
}

function setLocalAndSendMessage(sessionDescription) {
  // Set Opus as the preferred codec in SDP if Opus is present.
  sessionDescription.sdp = preferOpus(sessionDescription.sdp);
  pc.setLocalDescription(sessionDescription);
  console.log('setLocalAndSendMessage sending message' , sessionDescription);
  sendMessage(sessionDescription);
}

function requestTurn(turn_url) {
  var turnExists = false;
  for (var i in pc_config.iceServers) {
    if (pc_config.iceServers[i].url.substr(0, 5) === 'turn:') {
      turnExists = true;
      turnReady = true;
      break;
    }
  }
  if (!turnExists) {
    console.log('Getting TURN server from ', turn_url);
    var xhr = new XMLHttpRequest();
    xhr.onreadystatechange = function(){
      if (xhr.readyState === 4 && xhr.status === 200) {
        var turnServer = JSON.parse(xhr.responseText);
        console.log('Got TURN server: ', turnServer);
        pc_config.iceServers.push({
          'url': 'turn:' + turnServer.username + '@' + turnServer.turn,
          'credential': turnServer.password
        });
        turnReady = true;
      }
    };
    xhr.open('GET', turn_url, true);
    xhr.send();
  }
}

function handleRemoteStreamAdded(event) {
  console.log('Remote stream added.');
  remoteVideo.src = window.URL.createObjectURL(event.stream);
  remoteStream = event.stream;
}

function handleRemoteStreamRemoved(event) {
  console.log('Remote stream removed. Event: ', event);
}

function hangup() {
  console.log('Hanging up.');
  stop();
  sendMessage('bye');
}

function handleRemoteHangup() {
//  console.log('Session terminated.');
  // stop();
  // isInitiator = false;
}

function stop() {
  isStarted = false;
  // isAudioMuted = false;
  // isVideoMuted = false;
  pc.close();
  pc = null;
}

/****************************************************************************
 * Audio Control
 ****************************************************************************/

// Set Opus as the default audio codec if it's present.
function preferOpus(sdp) {
  var sdpLines = sdp.split('\r\n');
  var mLineIndex = null;
  // Search for m line.
  for (var i = 0; i < sdpLines.length; i++) {
      if (sdpLines[i].search('m=audio') !== -1) {
        mLineIndex = i;
        break;
      }
  }
  if (mLineIndex === null) {
    return sdp;
  }

  // If Opus is available, set it as the default in m line.
  for (i = 0; i < sdpLines.length; i++) {
    if (sdpLines[i].search('opus/48000') !== -1) {
      var opusPayload = extractSdp(sdpLines[i], /:(\d+) opus\/48000/i);
      if (opusPayload) {
        sdpLines[mLineIndex] = setDefaultCodec(sdpLines[mLineIndex], opusPayload);
      }
      break;
    }
  }

  // Remove CN in m line and sdp.
  sdpLines = removeCN(sdpLines, mLineIndex);

  sdp = sdpLines.join('\r\n');
  return sdp;
}

function extractSdp(sdpLine, pattern) {
  var result = sdpLine.match(pattern);
  return result && result.length === 2 ? result[1] : null;
}

// Set the selected codec to the first in m line.
function setDefaultCodec(mLine, payload) {
  var elements = mLine.split(' ');
  var newLine = [];
  var index = 0;
  for (var i = 0; i < elements.length; i++) {
    if (index === 3) { // Format of media starts from the fourth.
      newLine[index++] = payload; // Put target payload to the first.
    }
    if (elements[i] !== payload) {
      newLine[index++] = elements[i];
    }
  }
  return newLine.join(' ');
}

// Strip CN from sdp before CN constraints is ready.
function removeCN(sdpLines, mLineIndex) {
  var mLineElements = sdpLines[mLineIndex].split(' ');
  // Scan from end for the convenience of removing an item.
  for (var i = sdpLines.length-1; i >= 0; i--) {
    var payload = extractSdp(sdpLines[i], /a=rtpmap:(\d+) CN\/\d+/i);
    if (payload) {
      var cnPos = mLineElements.indexOf(payload);
      if (cnPos !== -1) {
        // Remove CN payload from m line.
        mLineElements.splice(cnPos, 1);
      }
      // Remove CN line in sdp
      sdpLines.splice(i, 1);
    }
  }

  sdpLines[mLineIndex] = mLineElements.join(' ');
  return sdpLines;
}

/**************************************************************************** 
 * Text Messaging Functions
 ****************************************************************************/

function addMessage(message, self) {
    var messageList = document.querySelector(".chat-inner-messages");

    var newMessage = document.createElement("li");
    newMessage.classList.add(".item");

    if (self) {
      newMessage.classList.add("self");
      newMessage.innerHTML = "<span class='badge'>You</span><p>" + message + "</p>";
    } else {
      newMessage.innerHTML = "<span class='badge'>" + 'friend' + "</span><p>" + message.data + "</p>"
    }

    messageList.appendChild(newMessage);

    chatInner.scrollTop = chatInner.scrollHeight;
}

function serverMessage(message) {
  var messageList = document.querySelector(".chat-inner-messages");
  var newMessage = document.createElement("li");
  newMessage.classList.add(".item");

  newMessage.innerHTML = "<span class='badge'>" + 'Message from Server' + "</span><p><b>" + message + "</b></p>"
  messageList.appendChild(newMessage);

  chatInner.scrollTop = chatInner.scrollHeight;
}

function createRoomName() {
    var MAX_LEN = 100;
    var text = sanitize(messageInput.value);
    var whiteSpaceRegEx = /^\s*$/.test(text);
    if(!whiteSpaceRegEx) {
        if(text.length < MAX_LEN) {
            room = '#' + text;
            roomURL.innerHTML = location.href + room;
            socket.emit('create or join', room);
            getUserMedia(constraints, handleUserMedia, handleUserMediaError);
            document.getElementById('text').value = '';
        }
    }
}

function sendText() {
    var CHUNK_LEN = 1000;
    var text = sanitize(messageInput.value);
    var whiteSpaceRegEx = /^\s*$/.test(text);
    if(!whiteSpaceRegEx) {
        if(text.length < CHUNK_LEN) {
            dataChannel.send(text);
            addMessage(text, true);
            document.getElementById('text').value = '';
        }
    }
}

function onMessageKeyDown(event) {
    if (event.keyCode == 13) {
        event.preventDefault();
        if(!room) {
          createRoomName();
        }
        else {
          sendText();
        }
    }
}

/**************************************************************************** 
 * Aux Functions
 ****************************************************************************/

function updateRoomURL(ipaddr) {
    var url;
    if (!ipaddr) {
        url = location.href
    } else {
        url = location.protocol + '//' + ipaddr + ':2014/' + room
    }
    roomURL.innerHTML = url;
}

function sanitize(msg) {
  msg = msg.toString();
  return msg.replace(/[\<\>"'\/]/g,function(c) {  var sanitize_replace = {
    "<" : "&lt;",
    ">" : "&gt;",
    '"' : "&quot;",
    "'" : "&#x27;",
    "/" : "&#x2F;"
  }
  return sanitize_replace[c]; });
}

