(function() {
	/*jshint devel: true*/
	/****************************************************************************
	 * Initial setup
	 ****************************************************************************/
	'use strict';
	if(window.location.protocol == 'http:' && !location.hostname.match(/localhost|127\.0\.0/))window.location.replace(window.location.href.replace('http:','https:'));

	let roomURL = document.getElementById('url'),
	remoteVideo = document.getElementById('remoteVideo'),
	localVideo = document.getElementById('localVideo'),
	trail = document.getElementById('trail'),
	chatInner = document.getElementById('chatInner'),
	messageInput = document.getElementById('text'),
	sendTextBtn = document.getElementById('sendText');

	let isChannelReady;
	let isInitiator = false;
	let isStarted = false;
	let localStream;
	let pc;
	let remoteStream;
	let turnReady;

	sendTextBtn.addEventListener('click', sendText);
	messageInput.addEventListener('keydown', onMessageKeyDown);

	let pc_config = {
		// empty object for twilio's STUN and TURN servers
	};

	// Set up audio and video regardless of what devices are present.
	let sdpConstraints = {'mandatory': {
		'OfferToReceiveAudio':true,
		'OfferToReceiveVideo':true }};

	/****************************************************************************
	 * Signaling server 
	 ****************************************************************************/

	let room = window.location.hash;
	if (!room) {
		serverMessage('You\'ve connected to an empty room. Please enter a room name below.');
	}

	let socket = io.connect();

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
			let candidate = new RTCIceCandidate({
				sdpMLineIndex: message.label,
				candidate: message.candidate
			});
			pc.addIceCandidate(candidate);
		} else if (message === 'bye' && isStarted) {
			serverMessage('Client has closed the connection. This room has closed. Further attempts to reconnect to room ' + room + ' will not work.');
			remoteVideo.style.opacity = '0';
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

	let constraints = {video: true, audio: true};
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
	let dataChannel;

	function onLocalSessionCreated(desc) {
			console.log('local session created:', desc);
			pc.setLocalDescription(desc, function () {
					console.log('sending local desc:', pc.localDescription);
					sendMessage(pc.localDescription);
			}, logError);
	}

	function onDataChannelCreated(channel) {
		channel.onopen = function () {
			console.log('channel opened!');
		};
		channel.onmessage = function(message) {
			addMessage(message);
		}
	}

	function createPeerConnection() {
		try {
			pc = new RTCPeerConnection(pc_config);
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
				console.log('Not Initiator');
				pc.ondatachannel = function (event) {
					dataChannel = event.channel;
					onDataChannelCreated(event.channel);
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

	function handleCreateAnswerError(e) {
		console.log('createAnswer() error: ', e)
	}

	function doCall() {
		console.log('Sending offer to peer');
		pc.createOffer(setLocalAndSendMessage, handleCreateOfferError);
	}

	function doAnswer() {
		console.log('Sending answer to peer.');
		pc.createAnswer(setLocalAndSendMessage, handleCreateAnswerError, sdpConstraints);
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

	function stop() {
		isStarted = false;
		pc.close();
		pc = null;
	}

	/****************************************************************************
	 * Audio Control
	 ****************************************************************************/

	// Set Opus as the default audio codec if it's present.
	function preferOpus(sdp) {
		let sdpLines = sdp.split('\r\n');
		let mLineIndex = null;
		// Search for m line.
		for (let i = 0; i < sdpLines.length; i++) {
			if (sdpLines[i].search('m=audio') !== -1) {
				mLineIndex = i;
				break;
			}
		}
		if (mLineIndex === null) {
			return sdp;
		}

		// If Opus is available, set it as the default in m line.
		for (let i = 0; i < sdpLines.length; i++) {
			if (sdpLines[i].search('opus/48000') !== -1) {
				let opusPayload = extractSdp(sdpLines[i], /:(\d+) opus\/48000/i);
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
		let result = sdpLine.match(pattern);
		return result && result.length === 2 ? result[1] : null;
	}

	// Set the selected codec to the first in m line.
	function setDefaultCodec(mLine, payload) {
		let elements = mLine.split(' ');
		let newLine = [];
		let index = 0;
		for (let i = 0; i < elements.length; i++) {
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
		let mLineElements = sdpLines[mLineIndex].split(' ');
		// Scan from end for the convenience of removing an item.
		for (let i = sdpLines.length-1; i >= 0; i--) {
			let payload = extractSdp(sdpLines[i], /a=rtpmap:(\d+) CN\/\d+/i);
			if (payload) {
				let cnPos = mLineElements.indexOf(payload);
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
		let messageList = document.querySelector(".chat-inner-messages");
		let lastMessage = $('.chat-inner-messages').children('li').last();
		console.log(lastMessage);

		let newMessage = document.createElement("li");
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
		let messageList = document.querySelector(".chat-inner-messages");
		let newMessage = document.createElement("li");
		newMessage.classList.add("server-message");

		newMessage.innerHTML = "<span class='badge'>" + 'Message from Server' + "</span><p><b>" + message + "</b></p>"
		messageList.appendChild(newMessage);

		chatInner.scrollTop = chatInner.scrollHeight;
	}

	function createRoomName() {
		let MAX_LEN = 100;
		let text = sanitize(messageInput.value).trim();
		if(/^[-a-z0-9]+$/i.test(text) && text.length < MAX_LEN) {
			room = '#' + text;
			socket.emit('create or join', room);
			getUserMedia(constraints, handleUserMedia, handleUserMediaError);
			document.getElementById('text').value = '';

		} else {
			serverMessage("Room names can only consist of lowercase alphanumeric characters and hyphens and must be under 100 characters long.");
		}
		
	}

	function sendText() {
		let CHUNK_LEN = 1000;
		let text = sanitize(messageInput.value).trim();
		if(!text) return;
		if(text.length < CHUNK_LEN) {
			dataChannel.send(text);
			addMessage(text, true);
			document.getElementById('text').value = '';
		} else {
			serverMessage("Message was not sent because it was too long.");
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
			let url;
			if (!ipaddr) {
					url = location.host +"/"+ room;
			} else {
					url = location.protocol + '//' + ipaddr + ':2014/' + room;
			}
			roomURL.innerHTML = url;
	}

	function sanitize(msg) {
		msg = msg.toString();
		return msg.replace(/[\<\>"'\/]/g,function(c) {  let sanitize_replace = {
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
		let sw = $(window).width();
		let sh = $(window).height();
		let margin = 20;
		let headHeight = 78;

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
})();