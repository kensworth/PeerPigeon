(function() {
	'use strict';
	let os = require('os');
	let node_static = require('node-static');
	let http = require('http');
	let file = new(node_static.Server)();
	let app = http.createServer(function (req, res) {
	  file.serve(req, res);
	}).listen(process.env.PORT || 2014);

	let env = require('node-env-file');
	env('./.env');
	let accountSid = process.env.TWILIO_ACCOUNT_SID;
	let authToken = process.env.TWILIO_AUTH_TOKEN;
	let client = require('twilio')(accountSid, authToken);

	client.tokens.create({}, function(err, token) {
		socketOpen(err, token);
	});

	function socketOpen(err, token) {
		let io = require('socket.io').listen(app);
		io.sockets.on('connection', function (socket){
			function log(){
				let array = [">>> Message from server: "];
			  for (let i = 0; i < arguments.length; i++) {
			  	array.push(arguments[i]);
			  }
			    socket.emit('log', array);
			}

			socket.on('message', function (message) {
				log('Got message: ', message);
		    // For a real app, should be room only (not broadcast)
				socket.broadcast.emit('message', message);
			});

			socket.on('create or join', function (room) {
				let numClients = io.sockets.clients(room).length;

				log('Room ' + room + ' has ' + numClients + ' client(s)');
				log('Request to create or join room', room);

				if (numClients == 0){
					socket.join(room);
					socket.emit('created', {room: room, ice_servers: token.ice_servers});
				} else if (numClients == 1) {
					io.sockets.in(room).emit('join', room);
					socket.join(room);
					socket.emit('joined', {room: room, ice_servers: token.ice_servers});
				} else { // max two clients
					socket.emit('full', room);
				}
				socket.emit('emit(): client ' + socket.id + ' joined room ' + room);
				socket.broadcast.emit('broadcast(): client ' + socket.id + ' joined room ' + room);

			});

			socket.on('ipaddr', function () {
		        let ifaces = os.networkInterfaces();
		        for (let dev in ifaces) {
		            ifaces[dev].forEach(function (details) {
		            	// if IPv4 and not localhost
		                if (details.family=='IPv4' && details.address != '127.0.0.1') {
		                    socket.emit('ipaddr', details.address);
		                }
		          });
		        }
		    });
		});
	}
})();