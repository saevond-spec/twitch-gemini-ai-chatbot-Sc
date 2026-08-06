// Near top, after imports and before other variables
let botInitialized = false; // <-- add this line

// Modify initializeBot function to check the flag
async function initializeBot() {
  if (botInitialized) {
    log.warn('Bot already initialized, skipping duplicate call');
    return;
  }
  botInitialized = true;
  // ... rest of initializeBot unchanged
}

// Modify the auth callback route
app.get('/auth/callback', async (req, res) => {
  // ... after exchangeCodeForToken
  if (!botInitialized) {
    await initializeBot();
  } else {
    log.info('Bot already running, skipping re-initialization');
  }
  // ... send response
});

// Modify bootstrap
async function bootstrap() {
  // ... after initAuth and emotes
  if (authorized && !botInitialized) {
    await initializeBot();
  } else if (!authorized) {
    log.info('No token, waiting for auth');
  }
  // ...
}
