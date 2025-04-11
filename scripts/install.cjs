const { spawn } = require('child_process');
const pty = require('node-pty');

const shell = pty.spawn('sudo', ['apt-get', 'install', '-y', 'tzdata'], {
  name: 'xterm-color',
  cols: 80,
  rows: 30,
  cwd: process.env.HOME,
  env: process.env
});

shell.on('data', (data) => {
  console.log(data);
  if (data.includes('Geographic area:')) {
    shell.write('12\r');
  }
  if (data.includes('Time zone:')) {
    shell.write('32\r');
  }
});

shell.on('exit', (code) => {
  if (code === 0) {
    const php = spawn('sudo', ['apt-get', 'install', '-y', 'php']);
    php.on('close', (code) => process.exit(code));
  } else {
    process.exit(code);
  }
});