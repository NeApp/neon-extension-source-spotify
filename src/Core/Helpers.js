import Log from 'neon-extension-source-spotify/Core/Logger';
import {awaitBody, awaitElements} from 'neon-extension-framework/Document/Await';


export function awaitPage() {
    return new Promise((resolve, reject) => {
        Log.debug('Waiting for page to load...');

        // Display loading warning every 60s
        let loadingInterval = setInterval(() => {
            Log.warn('Waiting for page to load...');
        }, 60 * 1000);

        // Wait for page to load
        awaitBody().then(() => awaitElements(
            document.body,
            '.navBar'
        )).then((element) => {
            Log.info('Page loaded');

            // Cancel loading warning
            clearInterval(loadingInterval);

            // Resolve promise
            resolve(element);
        }, (err) => {
            // Cancel loading warning
            clearInterval(loadingInterval);

            // Reject promise
            reject(err);
        });
    });
}
