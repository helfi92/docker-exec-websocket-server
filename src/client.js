const EventEmitter = require('wolfy87-eventemitter');
const msgcode = require('../lib/messagecodes.js');
const querystring = require('querystring');
const through2 = require('through2').obj;
const Promise = require('promise');

module.exports = class DockerExecWebsocketClient extends EventEmitter {
  constructor(options) {
    super();
    this.options = Object.assign({}, {
      tty: true,
      command: 'sh',
    }, options);
  }

  /* Makes a client program with unbroken stdin, stdout, stderr streams
   * Is also an EventEmitter with 'exit' event
   *
   * Required options:
   * url parts (hostname port pathname)
   * or url
   * tty: whether or not we expect VT100 style output
   * command: array or string of command to be run in exec
   */
  async execute() {
    this.url = this.options.url + '?' + querystring.stringify({
      tty: this.options.tty ? 'true' : 'false',
      command: this.options.command,
    });

    if (!/ws?s:\/\//.test(this.url)) {
      throw(new Error('URL required or malformed'));
    }

    this.socket = new WebSocket(this.url);
    this.socket.binaryType = 'arraybuffer';
    this.socket.addEventListener('open', () => {
      this.emitEvent('open');
    });

    this.stdin = through2((data, enc, cb) => {
      this.sendMessage(msgcode.stdin, data);
      cb();
    }, cb => {
      this.sendCode(msgcode.end);
      cb();
    });

    const MAX_OUTSTANDING_BYTES = 8 * 1024 * 1024;
    this.outstandingBytes = 0;

    //stream with pause buffering, everything passes thru here first
    this.strbuf = through2();
    this.strbuf.on('data', data => {
      this.outstandingBytes += data.length;
      this.socket.send(data);
      this.outstandingBytes -= data.length;
  
      if (this.outstandingBytes > MAX_OUTSTANDING_BYTES) {
        this.strbuf.pause();
        this.emitEvent('paused');
      } else {
        this.strbuf.resume();
        this.emitEvent('resumed');
      }
    });
    //Starts out paused so that input isn't sent until server is ready
    this.strbuf.pause();

    this.stdout = through2();
    this.stderr = through2();
    this.stdout.draining = false;
    this.stderr.draining = false;

    this.stdout.on('drain', () => {
      this.stdout.draining = false;
      if (!this.stderr.draining) {
        this.sendCode(msgcode.resume);
      }
    });

    this.stderr.on('drain', () => {
      this.stderr.draining = false;
      if (!this.stdout.draining) {
        this.sendCode(msgcode.resume);
      }
    });

    this.socket.onmessage = messageEvent => {
      this.messageHandler(messageEvent);
    };

    await new Promise((accept, reject) => {
      this.socket.addEventListener('error', reject);
      this.socket.addEventListener('open', accept);
    });
    this.socket.addEventListener('error', err => this.emitEvent('error', err));
  }

  messageHandler(messageEvent) {
    let message = new Uint8Array(messageEvent.data);
    // the first byte is the message code
    switch (message[0]) {
      //pauses the client, causing strbuf to buffer
      case msgcode.pause:
        this.strbuf.pause();
        this.emitEvent('paused');
        break;

      //resumes the client, flushing strbuf
      case msgcode.resume:
        this.strbuf.resume();
        this.emitEvent('resumed');
        break;

      case msgcode.stdout:
        if (!this.stdout.write(message.slice(1))) {
          this.sendCode(msgcode.pause);
          this.stdout.draining = true;
        }
        break;

      case msgcode.stderr:
        if (!this.stderr.write(message.slice(1))) {
          this.sendCode(msgcode.pause);
          this.stderr.draining = true;
        }
        break;

      //first byte contains exit code
      case msgcode.stopped:
        this.emitEvent('exit', message.readInt8(1));
        this.close();
        break;

      case msgcode.shutdown:
        this.emitEvent('shutdown');
        this.close();
        break;

      case msgcode.error:
        this.emitEvent('error', message.slice(1));
        break;
      
      default:
        break;
    }
  }

  resize(h, w) {
    if (!this.options.tty) {
      throw new Error('cannot resize, not a tty instance');
    }
    
    const buf = new Uint8Array(4);

    this.sendCode(msgcode.resume);
    buf.set(new Uint16Array([h]), 0);
    buf.set(new Uint16Array([w]), 2);
    this.sendMessage(msgcode.resize, buf);
  }

  sendCode(code) {
    this.strbuf.write(new Uint8Array([code]));
  }

  sendMessage(code, data) {
    code = new Uint8Array([code]);
    data = data instanceof Uint8Array ? data : new Uint8Array([data.charCodeAt(0)]);
    const message = new Uint8Array(data.length + code.length);
    
    message.set(code);
    message.set(data, code.length);

    this.strbuf.write(message);
  }

  close() {
    if (!this.strbuf.paused) {
      this.socket.close();
      this.stdin.end();
      this.stdout.end();
      this.stderr.end();
      this.strbuf.end();
    } else {
      this.strbuf.on('drain', () => {
        this.socket.close();
        this.stdin.end();
        this.stdout.end();
        this.stderr.end();
        this.strbuf.end();
      });
    }
  }
};
