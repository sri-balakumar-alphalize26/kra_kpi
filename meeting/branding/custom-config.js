// How the call behaves. Change a value, save, run
// ..\server\start-meeting.cmd, then reload the meeting page.

// Language of every word on the call screen ('en', 'hi', 'ml', 'ta', ...).
config.defaultLanguage = 'en';

// Join with camera or microphone off (true = off).
config.startWithVideoMuted = false;
config.startWithAudioMuted = false;

// Highest video quality sent, in lines (360, 720, 1080). Lower saves data.
config.resolution = 720;
config.constraints = { video: { height: { ideal: 720, max: 720, min: 180 } } };

// Buttons shown when someone opens a room directly. Calls opened from the
// Odoo page use the Odoo page's own list instead.
config.toolbarButtons = ['microphone', 'camera', 'desktop', 'chat', 'raisehand', 'tileview', 'hangup'];

// Never send people to Jitsi's own pages or apps.
config.disableDeepLinking = true;
config.enableClosePage = false;
config.prejoinConfig = { enabled: false };
