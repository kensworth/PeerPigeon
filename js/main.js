/****************************************************************************
 * Initial setup
 ****************************************************************************/
'use strict';
if(window.location.protocol == 'http:' && !location.hostname.match(/localhost|127\.0\.0/))window.location.replace(window.location.href.replace('http:','https:'));

var roomURL = document.getElementById('url'),
remoteVideo = document.getElementById('remoteVideo'),
localVideo = document.getElementById('localVideo'),
trail = document.getElementById('trail'),
chatInner = document.getElementById('chatInner'),
messageInput = document.getElementById('text'),
sendTextBtn = document.getElementById('sendText'),
//filesharing
bitrateDiv = document.querySelector('div#bitrate'),
fileInput = document.querySelector('input#fileInput'),
downloadAnchor = document.querySelector('a#download'),
sendProgress = document.querySelector('progress#sendProgress'),
receiveProgress = document.querySelector('progress#receiveProgress'),
statusMessage = document.querySelector('span#status');
//end filesharing

var isChannelReady;
var isInitiator = false;
var isStarted = false;
var localStream;
var pc;
var remoteStream;
var turnReady;

//filesharing
var localConnection;
var remoteConnection;
var sendChannel;
var receiveChannel;
var pcConstraint;

var receiveBuffer = [];
var receivedSize = 0;

var bytesPrev = 0;
var timestampPrev = 0;
var timestampStart;
var statsInterval = null;
var bitrateMax = 0;

//fileInput.addEventListener('change', createConnection, false);
//end filesharing

sendTextBtn.addEventListener('click', sendText);
messageInput.addEventListener('keydown', onMessageKeyDown);

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

socket.on('created', function (data){
	console.log('Created room ' + data.room);
	pc_config = {
		iceServers: data.ice_servers
	};
	isInitiator = true;
	serverMessage('Success! Room created at ' + location.host +"/"+ room);
	updateRoomURL();
	history.pushState({random: "New room"}, '', room);
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

socket.on('joined', function (data){
	console.log('This peer has joined room ' + data.room);
	pc_config = {
		iceServers: data.ice_servers
	};
	isChannelReady = true;
	serverMessage('Success! Joined room at ' + window.location.hostname + '/' + room);
	updateRoomURL();
	history.pushState({random: "New room"}, '', room);
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
		serverMessage('Client has closed the connection.');
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
		pc.setLocalDescription(desc, function () {
				console.log('sending local desc:', pc.localDescription);
				sendMessage(pc.localDescription);
		}, logError);
}

function onDataChannelCreated(channel) {
	console.log('onDataChannelCreated:', channel);

	if(channel.label == 'media') {
		channel.onopen = function () {
			console.log('channel opened!');
		};
		channel.onmessage = function(message) {
			addMessage(message);
		}
	}
	else if(channel.label == 'sendDataChannel') {
		if(isInitiator) {
			sendChannel.onopen = onSendChannelStateChange;
  		sendChannel.onclose = onSendChannelStateChange;
		}
		else {
			trace('Receive Channel Callback');
		  receiveChannel = event.channel;
		  receiveChannel.binaryType = 'arraybuffer';
		  receiveChannel.onmessage = onReceiveMessageCallback;
		  receiveChannel.onopen = onReceiveChannelStateChange;
		  receiveChannel.onclose = onReceiveChannelStateChange;

		  receivedSize = 0;
		  bitrateMax = 0;
		  downloadAnchor.textContent = '';
		  downloadAnchor.removeAttribute('download');
		  if (downloadAnchor.href) {
		    URL.revokeObjectURL(downloadAnchor.href);
		    downloadAnchor.removeAttribute('href');
		  }
		}
	}
}

function createPeerConnection() {
	try {
		pc = new RTCPeerConnection(pc_config);
		pc.onicecandidate = handleIceCandidate;
		pc.onaddstream = handleRemoteStreamAdded;
		pc.onremovestream = handleRemoteStreamRemoved;
		fileInput.disabled = true;
		if (isInitiator) {
			console.log('Creating Data Channel');
			dataChannel = pc.createDataChannel("media");
			onDataChannelCreated(dataChannel);

			//file channel
			sendChannel = pc.createDataChannel('sendDataChannel');
  		onDataChannelCreated(sendChannel);

			console.log('Creating an offer');
			pc.createOffer(onLocalSessionCreated, logError);
		} else {
			console.log('Not Initiator');
			pc.ondatachannel = function (event) {
				console.log('ondatachannel:', event.channel);
				dataChannel = event.channel;
				onDataChannelCreated(dataChannel);
			};
		}
		console.log('Created RTCPeerConnnection');
		serverMessage('Created RTCPeerConnnection');
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

function handleRemoteStreamAdded(event) {
	console.log('Remote stream added.');
	serverMessage('Streaming Video');
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
	//serverMessage('Client has closed the connection.');
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
	var lastMessage = $('.chat-inner-messages').children('li').last();
	console.log(lastMessage);

	var newMessage = document.createElement("li");
	newMessage.classList.add("item");
	newMessage.innerHTML = "";

	if (self) {
		newMessage.classList.add("self");
		if(!lastMessage.hasClass('self') || lastMessage.hasClass('server-message')) {
			 newMessage.innerHTML = "<span class='badge'>You</span>"
		} 
		newMessage.innerHTML += "<p>" + message + "</p>";
	} else {
		if(lastMessage.hasClass('self') || lastMessage.hasClass('server-message') ) {
			newMessage.innerHTML = "<span class='badge'>" + 'friend' + "</span>";
		}
			newMessage.innerHTML +=  "<p>" + message.data + "</p>";
	}

	messageList.appendChild(newMessage);

	chatInner.scrollTop = chatInner.scrollHeight;
}

function serverMessage(message) {
	var messageList = document.querySelector(".chat-inner-messages");
	var newMessage = document.createElement("li");
	newMessage.classList.add("server-message");

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
 * File Transfer
 ****************************************************************************/
function onCreateSessionDescriptionError(error) {
	trace('Failed to create session description: ' + error.toString());
}

function sendData() {
	var file = fileInput.files[0];
	trace('file is ' + [file.name, file.size, file.type,
			file.lastModifiedDate].join(' '));

	// Handle 0 size files.
	statusMessage.textContent = '';
	downloadAnchor.textContent = '';
	if (file.size === 0) {
		bitrateDiv.innerHTML = '';
		statusMessage.textContent = 'File is empty, please select a non-empty file';
		closeDataChannels();
		return;
	}
	sendProgress.max = file.size;
	receiveProgress.max = file.size;
	var chunkSize = 16384;
	var sliceFile = function(offset) {
		var reader = new window.FileReader();
		reader.onload = (function() {
			return function(e) {
				sendChannel.send(e.target.result);
				if (file.size > offset + e.target.result.byteLength) {
					window.setTimeout(sliceFile, 0, offset + chunkSize);
				}
				sendProgress.value = offset + e.target.result.byteLength;
			};
		})(file);
		var slice = file.slice(offset, offset + chunkSize);
		reader.readAsArrayBuffer(slice);
	};
	sliceFile(0);
}

function closeDataChannels() {
	trace('Closing data channels');
	sendChannel.close();
	trace('Closed data channel with label: ' + sendChannel.label);
	if (receiveChannel) {
		receiveChannel.close();
		trace('Closed data channel with label: ' + receiveChannel.label);
	}
	localConnection.close();
	remoteConnection.close();
	localConnection = null;
	remoteConnection = null;
	trace('Closed peer connections');

	// re-enable the file select
	fileInput.disabled = false;
}

function gotDescription1(desc) {
	localConnection.setLocalDescription(desc);
	trace('Offer from localConnection \n' + desc.sdp);
	remoteConnection.setRemoteDescription(desc);
	remoteConnection.createAnswer(gotDescription2,
			onCreateSessionDescriptionError);
}

function gotDescription2(desc) {
	remoteConnection.setLocalDescription(desc);
	trace('Answer from remoteConnection \n' + desc.sdp);
	localConnection.setRemoteDescription(desc);
}

function iceCallback1(event) {
	trace('local ice callback');
	if (event.candidate) {
		remoteConnection.addIceCandidate(event.candidate,
				onAddIceCandidateSuccess, onAddIceCandidateError);
		trace('Local ICE candidate: \n' + event.candidate.candidate);
	}
}

function iceCallback2(event) {
	trace('remote ice callback');
	if (event.candidate) {
		localConnection.addIceCandidate(event.candidate,
				onAddIceCandidateSuccess, onAddIceCandidateError);
		trace('Remote ICE candidate: \n ' + event.candidate.candidate);
	}
}

function onAddIceCandidateSuccess() {
	trace('AddIceCandidate success.');
}

function onAddIceCandidateError(error) {
	trace('Failed to add Ice Candidate: ' + error.toString());
}

function receiveChannelCallback(event) {
	trace('Receive Channel Callback');
	receiveChannel = event.channel;
	receiveChannel.binaryType = 'arraybuffer';
	receiveChannel.onmessage = onReceiveMessageCallback;
	receiveChannel.onopen = onReceiveChannelStateChange;
	receiveChannel.onclose = onReceiveChannelStateChange;

	receivedSize = 0;
	bitrateMax = 0;
	downloadAnchor.textContent = '';
	downloadAnchor.removeAttribute('download');
	if (downloadAnchor.href) {
		URL.revokeObjectURL(downloadAnchor.href);
		downloadAnchor.removeAttribute('href');
	}
}

function onReceiveMessageCallback(event) {
	// trace('Received Message ' + event.data.byteLength);
	receiveBuffer.push(event.data);
	receivedSize += event.data.byteLength;

	receiveProgress.value = receivedSize;

	// we are assuming that our signaling protocol told
	// about the expected file size (and name, hash, etc).
	var file = fileInput.files[0];
	if (receivedSize === file.size) {
		var received = new window.Blob(receiveBuffer);
		receiveBuffer = [];

		downloadAnchor.href = URL.createObjectURL(received);
		downloadAnchor.download = file.name;
		downloadAnchor.textContent =
			'Click to download \'' + file.name + '\' (' + file.size + ' bytes)';
		downloadAnchor.style.display = 'block';

		var bitrate = Math.round(receivedSize * 8 /
				((new Date()).getTime() - timestampStart));
		bitrateDiv.innerHTML = '<strong>Average Bitrate:</strong> ' +
				bitrate + ' kbits/sec (max: ' + bitrateMax + ' kbits/sec)';

		if (statsInterval) {
			window.clearInterval(statsInterval);
			statsInterval = null;
		}

		closeDataChannels();
	}
}

function onSendChannelStateChange() {
	var readyState = sendChannel.readyState;
	trace('Send channel state is: ' + readyState);
	if (readyState === 'open') {
		sendData();
	}
}

function onReceiveChannelStateChange() {
	var readyState = receiveChannel.readyState;
	trace('Receive channel state is: ' + readyState);
	if (readyState === 'open') {
		timestampStart = (new Date()).getTime();
		timestampPrev = timestampStart;
		statsInterval = window.setInterval(displayStats, 500);
		window.setTimeout(displayStats, 100);
		window.setTimeout(displayStats, 300);
	}
}

// display bitrate statistics.
function displayStats() {
	var display = function(bitrate) {
		bitrateDiv.innerHTML = '<strong>Current Bitrate:</strong> ' +
				bitrate + ' kbits/sec';
	};

	if (remoteConnection &&
			remoteConnection.iceConnectionState === 'connected') {
		if (webrtcDetectedBrowser === 'chrome') {
			// TODO: once https://code.google.com/p/webrtc/issues/detail?id=4321
			// lands those stats should be preferrred over the connection stats.
			remoteConnection.getStats(null, function(stats) {
				for (var key in stats) {
					var res = stats[key];
					if (timestampPrev === res.timestamp) {
						return;
					}
					if (res.type === 'googCandidatePair' &&
							res.googActiveConnection === 'true') {
						// calculate current bitrate
						var bytesNow = res.bytesReceived;
						var bitrate = Math.round((bytesNow - bytesPrev) * 8 /
								(res.timestamp - timestampPrev));
						display(bitrate);
						timestampPrev = res.timestamp;
						bytesPrev = bytesNow;
						if (bitrate > bitrateMax) {
							bitrateMax = bitrate;
						}
					}
				}
			});
		} else {
			// Firefox currently does not have data channel stats. See
			// https://bugzilla.mozilla.org/show_bug.cgi?id=1136832
			// Instead, the bitrate is calculated based on the number of
			// bytes received.
			var bytesNow = receivedSize;
			var now = (new Date()).getTime();
			var bitrate = Math.round((bytesNow - bytesPrev) * 8 /
					(now - timestampPrev));
			display(bitrate);
			timestampPrev = now;
			bytesPrev = bytesNow;
			if (bitrate > bitrateMax) {
				bitrateMax = bitrate;
			}
		}
	}
}

/**************************************************************************** 
 * Aux Functions
 ****************************************************************************/

function updateRoomURL(ipaddr) {
		var url;
		if (!ipaddr) {
				url = location.host +"/"+ room;
		} else {
				url = location.protocol + '//' + ipaddr + ':2014/' + room;
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

function logError(err) {
		console.log(err.toString(), err);
}

/****************************************************************************
 * Styling jQuery
 ****************************************************************************/

$(document).ready(function() {
	elementSizing();
});

$(window).on('resize', function(){
	elementSizing();

});

function elementSizing() {
	var sw = $(window).width();
	var sh = $(window).height();
	var margin = 20;
	var headHeight = 78;

	$('video, .video-container img').css({
		"height": (sh - (3*margin) - headHeight)/2 + "px",
		"width": (1+ (1/3))*(sh - (3*margin) - headHeight)/2 + "px",
	});
	$('.chat-half').css("height", (sh - 2*margin - 34 - headHeight) + "px");

	if($('.video-app').width() < (2*margin) + $('.video-container video').width() ) {
		$('video, .video-container img').css({
			"width":"100%",
			"height":"auto"
		});
		$('.chat-half').css("height",$('video').height()*2 - 34 + margin +"px");
	}
}

