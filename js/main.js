/****************************************************************************
 * Initial setup
 ****************************************************************************/

var configuration = {'iceServers': [{'url': 'stun:stun.l.google.com:19302'}]},
// {"url":"stun:stun.services.mozilla.com"}

    roomURL = document.getElementById('url'),
    remoteVideo = document.getElementById('remoteVideo'),
    localVideo = document.getElementById('localVideo'),
    trail = document.getElementById('trail'),
    chatInner = document.getElementById('chatInner');
    messageInput = document.getElementById('text'),
    sendTextBtn = document.getElementById('sendText');

// Attach event handlers
sendTextBtn.addEventListener('click', sendText);
messageInput.addEventListener("keydown", onMessageKeyDown);

/****************************************************************************
 * Signaling server 
 ****************************************************************************/

// Connect to the signaling server
var socket = io.connect();

// Create a random room if not already present in the URL.
var isInitiator;
var room = window.location.hash.substring(1);
if (!room) {
    socket.emit('make room');
}
else {
    socket.emit('create or join', room);
}

socket.on('created room', function(generatedRoom) {
    room = generatedRoom;
    room = window.location.hash = generatedRoom;
    console.log('created room: ' + room);
    socket.emit('create or join', room);
});

socket.on('ipaddr', function (ipaddr) {
    console.log('Server IP address is: ' + ipaddr);
    updateRoomURL(ipaddr);
});

socket.on('created', function (room, clientId) {
  console.log('Created room', room, '- my client ID is', clientId);
  isInitiator = true;
  grabWebCamVideo();
});

socket.on('joined', function (room, clientId) {
  console.log('This peer has joined room', room, 'with client ID', clientId);
  isInitiator = false;
  grabWebCamVideo();
});

socket.on('full', function (room) {
    alert('Room "' + room + '" is full. We will create a new room for you.');
    window.location.hash = '';
    window.location.reload();
});

socket.on('ready', function () {
    createPeerConnection(isInitiator, configuration);
})

socket.on('log', function (array) {
  console.log.apply(console, array);
});

socket.on('message', function (message){
    console.log('Client received message:', message);
    signalingMessageCallback(message);
});

if (location.hostname.match(/localhost|127\.0\.0/)) {
    socket.emit('ipaddr');
}

/**
 * Send message to signaling server
 */
function sendMessage(message){
    console.log('Client sending message: ', message);
    socket.emit('message', message);
}

/**
 * Updates URL on the page so that users can copy&paste it to their peers.
 */
function updateRoomURL(ipaddr) {
    var url;
    if (!ipaddr) {
        url = location.href
    } else {
        url = location.protocol + '//' + ipaddr + ':2013/' + room
    }
    roomURL.innerHTML = url;
}


/**************************************************************************** 
 * User media (webcam) 
 ****************************************************************************/

function grabWebCamVideo() {
    console.log('Getting user media (video) ...');
    getUserMedia({video: true, audio: true}, getMediaSuccessCallback, getMediaErrorCallback);
}

function getMediaSuccessCallback(stream) {
    var streamURL = window.URL.createObjectURL(stream);
    console.log('getUserMedia video stream URL:', streamURL);
    window.stream = stream; // stream available to console

    localVideo.src = streamURL;
}

function getMediaErrorCallback(error){
    console.log("getUserMedia error:", error);
}


/**************************************************************************** 
 * WebRTC peer connection and data channel
 ****************************************************************************/

var peerConn;
var dataChannel;

function signalingMessageCallback(message) {
    if (message.type === 'offer') {
        console.log('Got offer. Sending answer to peer.');
        peerConn.setRemoteDescription(new RTCSessionDescription(message), function(){}, logError);
        peerConn.createAnswer(onLocalSessionCreated, logError);

    } else if (message.type === 'answer') {
        console.log('Got answer.');
        peerConn.setRemoteDescription(new RTCSessionDescription(message), function(){}, logError);

    } else if (message.type === 'candidate') {
        peerConn.addIceCandidate(new RTCIceCandidate({candidate: message.candidate}));

    } else if (message === 'bye') {
        // TODO: cleanup RTC connection?
    }
}

function createPeerConnection(isInitiator, config) {
    console.log('Creating Peer connection as initiator?', isInitiator, 'config:', config);
    peerConn = new RTCPeerConnection(config);

    // send any ice candidates to the other peer
    peerConn.onicecandidate = function (event) {
        console.log('onIceCandidate event:', event);
        if (event.candidate) {
            sendMessage({
                type: 'candidate',
                label: event.candidate.sdpMLineIndex,
                id: event.candidate.sdpMid,
                candidate: event.candidate.candidate
            });
        } else {
            console.log('End of candidates.');
        }
    };

    if (isInitiator) {
        console.log('Creating Data Channel');
        dataChannel = peerConn.createDataChannel("media");
        onDataChannelCreated(dataChannel);

        console.log('Creating an offer');
        peerConn.createOffer(onLocalSessionCreated, logError);
    } else {
        peerConn.ondatachannel = function (event) {
            console.log('ondatachannel:', event.channel);
            dataChannel = event.channel;
            onDataChannelCreated(dataChannel);
        };
    }
}

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

/**************************************************************************** 
 * Aux functions, mostly UI-related
 ****************************************************************************/

function sendText() {
    var CHUNK_LEN = 1000;
    var text = messageInput.value;
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
        sendText();
    }
}

function logError(err) {
    console.log(err.toString(), err);
}
