import ngrok from '@ngrok/ngrok';

export async function ngrokForwarder() {
    const authToken = process.env.NGROK_AUTH_TOKEN;
    if (!authToken) {
        throw new Error('NGROK_AUTH_TOKEN must be set to start the development tunnel');
    }

    const port = process.env.PORT || 8000;
    const listener = await ngrok.forward({ addr: port, authtoken: authToken });
    const url = listener.url();
    if (!url) {
        throw new Error('ngrok did not provide a public URL');
    }

    console.log(`Generated new ngrok URL: ${url}`);

    process.env.WEBHOOK_URL = url;
    return listener;
}
