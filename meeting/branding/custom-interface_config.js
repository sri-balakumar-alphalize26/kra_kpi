// What the call screen looks like. Change a value, save, run
// ..\server\start-meeting.cmd, then reload the meeting page.
// Note: the Odoo meeting page can override some of these for its own calls
// (see ..\README.md, "Who decides what").

interfaceConfig.APP_NAME = 'Alphalize Meet';
interfaceConfig.NATIVE_APP_NAME = 'Alphalize Meet';
interfaceConfig.PROVIDER_NAME = 'Alphalize';

// Our logo in the corner of the call, and where clicking it goes.
interfaceConfig.DEFAULT_LOGO_URL = 'images/alphalize-logo.png';
interfaceConfig.DEFAULT_WELCOME_PAGE_LOGO_URL = 'images/alphalize-logo.png';
interfaceConfig.JITSI_WATERMARK_LINK = 'https://alphalize.com';
interfaceConfig.SHOW_JITSI_WATERMARK = true;
interfaceConfig.SHOW_BRAND_WATERMARK = false;
interfaceConfig.SHOW_POWERED_BY = false;

// Background behind people with their camera off.
interfaceConfig.DEFAULT_BACKGROUND = '#0f2a24';

// No "download the app" prompts on phones.
interfaceConfig.MOBILE_APP_PROMO = false;
interfaceConfig.HIDE_INVITE_MORE_HEADER = true;
