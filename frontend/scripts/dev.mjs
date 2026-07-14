import { spawn } from 'node:child_process';
import kill from 'tree-kill';
import process from 'node:process';

// Spawn electron-forge start and inherit stdio
const child = spawn('npx', ['electron-forge', 'start'], {
	stdio: 'inherit',
	shell: process.platform === 'win32'
});

// Capture SIGINT (Ctrl+C in terminal) and kill the whole tree forcefully
process.on('SIGINT', () => {
	if (child.pid) {
		kill(child.pid, 'SIGKILL', (err) => {
			if (err) console.error('Failed to kill child tree:', err);
			process.exit(0);
		});
	} else {
		process.exit(0);
	}
});

// Also handle SIGTERM (e.g. standard kill command)
process.on('SIGTERM', () => {
	if (child.pid) {
		kill(child.pid, 'SIGKILL', (err) => {
			if (err) console.error('Failed to kill child tree:', err);
			process.exit(0);
		});
	} else {
		process.exit(0);
	}
});
