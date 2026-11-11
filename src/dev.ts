import 'dotenv/config';
import { ngrokForwarder } from './lib/ngrok';

async function startDevelopmentServer() {
    const listener = await ngrokForwarder();
    let shuttingDown = false;

    const shutdown = async (signal: NodeJS.Signals) => {
        if (shuttingDown) {
            return;
        }

        shuttingDown = true;
        try {
            await listener.close();
        } catch (error: unknown) {
            console.error('Failed to close ngrok listener:', error);
        } finally {
            process.kill(process.pid, signal);
        }
    };

    process.once('SIGUSR2', () => void shutdown('SIGUSR2'));
    process.once('SIGINT', () => void shutdown('SIGINT'));
    process.once('SIGTERM', () => void shutdown('SIGTERM'));

    try {
        await import('./index');
    } catch (error: unknown) {
        try {
            await listener.close();
        } catch (closeError: unknown) {
            console.error('Failed to close ngrok listener after startup failure:', closeError);
        }

        throw error;
    }
}

startDevelopmentServer().catch((error: unknown) => {
    console.error('Failed to start development server with ngrok:', error);
    process.exitCode = 1;
});
