# Ultimate Dev Tools — Google OAuth Setup

To enable Google Login and cross-device sync, follow these steps:

## 1. Create a Google Cloud Project
1. Go to https://console.cloud.google.com
2. Click "New Project" and name it "Ultimate Dev Tools"
3. Select it as your active project

## 2. Enable Required APIs
1. Go to APIs & Services → Library
2. Search and enable: **Google Drive API**
3. Search and enable: **Google People API**

## 3. Create OAuth Credentials
1. Go to APIs & Services → Credentials
2. Click "Create Credentials" → "OAuth client ID"
3. Choose **Chrome App** as the application type
4. For "Application ID", enter your extension's ID
   - Load the extension unpacked in Chrome first
   - Go to chrome://extensions and copy the ID shown under "Ultimate Dev Tools"
5. Click Create — copy the Client ID shown

## 4. Add Client ID to Extension
1. Open `manifest.json`
2. Replace `REPLACE_WITH_YOUR_GOOGLE_CLIENT_ID` with your actual Client ID
3. Save and reload the extension in Chrome

## 5. Configure OAuth Consent Screen
1. Go to APIs & Services → OAuth consent screen
2. Choose "External"
3. Fill in App name: "Ultimate Dev Tools", your email, etc.
4. Add scopes:
   - `../auth/drive.appdata`
   - `../auth/userinfo.profile`
   - `../auth/userinfo.email`
5. Add your Google account as a test user

## Notes
- The extension syncs settings to a hidden Google Drive appdata folder (invisible to the user, not accessible by other apps)
- Private keys are stored locally only and are NOT synced to Google Drive for security
- Wallet names, emojis, public keys, and all settings ARE synced
