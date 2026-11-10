// Build-time settings for the official openVideo app. Users never see or edit these.
// Self-hosting your own website? Set OPENVIDEO_SITE_URL / OPENVIDEO_GITHUB_CLIENT_ID when building or running.
module.exports = {
  // Public website that serves share links (the Vercel deployment of web/).
  SITE_URL: process.env.OPENVIDEO_SITE_URL || 'https://open-video-rose.vercel.app',
  // Client ID of the GitHub OAuth App (public, not a secret). Device Flow must be enabled on that app.
  GITHUB_CLIENT_ID: process.env.OPENVIDEO_GITHUB_CLIENT_ID || 'Ov23ctq6ja3ORn1FrhmE',
};
