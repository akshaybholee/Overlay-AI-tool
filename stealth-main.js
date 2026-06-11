const { app, BrowserWindow, globalShortcut, ipcMain, screen, nativeImage, Tray, Menu } = require('electron');
const axios = require('axios');
const screenshotDesktop = require('screenshot-desktop');
const path = require('path');
// Resolve .env from resources dir when packaged, project root in dev
require('dotenv').config({
  path: app.isPackaged
    ? path.join(process.resourcesPath, '.env')
    : path.join(__dirname, '.env')
});

// Disguise process name in Task Manager
app.setName('Windows Runtime Host');

let overlayWindow = null;
let cropperWindow = null;
let tray = null;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-exp:free';
// Local model server (Ollama, OpenAI-compatible). Models prefixed "local:" route here.
// Use 127.0.0.1 (not "localhost") — Node/Electron resolves localhost to IPv6 ::1,
// but Ollama listens only on IPv4, causing ECONNREFUSED.
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434/v1/chat/completions';
// Direct OpenAI API. Models prefixed "openai:" route here using OPENAI_API_KEY.
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

console.log('=== AI OVERLAY TOOL (OPENROUTER) ===');
console.log('Model:', MODEL);
console.log('API Key:', OPENROUTER_API_KEY ? '✓ Present' : '❌ Missing');

// Capture a specific screen using screenshot-desktop (uses native Windows APIs, no GPU needed)
async function captureScreen(electronDisplay) {
  try {
    const displays = await screenshotDesktop.listDisplays();
    // Match Electron display to screenshot-desktop display by top-left position
    const match = displays.find(d =>
      Math.abs(d.left - electronDisplay.bounds.x) < 20 &&
      Math.abs(d.top - electronDisplay.bounds.y) < 20
    );
    const screenId = match ? match.id : undefined;
    const buffer = await screenshotDesktop({ screen: screenId, format: 'png' });
    return buffer;
  } catch (error) {
    console.error('Screen capture error:', error);
    throw error;
  }
}

// Crop an image using Electron's built-in nativeImage (no native module compilation needed)
function cropImage(imageBuffer, bounds) {
  try {
    const img = nativeImage.createFromBuffer(imageBuffer);
    const size = img.getSize();
    // Clamp bounds to image dimensions to avoid errors
    const x = Math.max(0, Math.round(bounds.x));
    const y = Math.max(0, Math.round(bounds.y));
    const width = Math.min(Math.round(bounds.width), size.width - x);
    const height = Math.min(Math.round(bounds.height), size.height - y);
    const cropped = img.crop({ x, y, width, height });
    return cropped.toPNG();
  } catch (error) {
    console.error('Crop error:', error);
    return imageBuffer;
  }
}

// Get the screen where the overlay is located
function getOverlayScreen() {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    return screen.getPrimaryDisplay();
  }
  
  const windowBounds = overlayWindow.getBounds();
  const displays = screen.getAllDisplays();
  
  const windowCenterX = windowBounds.x + windowBounds.width / 2;
  const windowCenterY = windowBounds.y + windowBounds.height / 2;
  
  const targetDisplay = displays.find(display => {
    return (windowCenterX >= display.bounds.x && 
            windowCenterX <= display.bounds.x + display.bounds.width &&
            windowCenterY >= display.bounds.y && 
            windowCenterY <= display.bounds.y + display.bounds.height);
  });
  
  return targetDisplay || screen.getPrimaryDisplay();
}

// Create the invisible cropper overlay ONCE and keep it alive (hidden) for reuse.
// Pre-loading the window + HTML at startup avoids the multi-second delay of
// recreating it on every crop.
function createCropperWindow() {
  if (cropperWindow && !cropperWindow.isDestroyed()) {
    return cropperWindow; // already created — reuse it
  }

  const primary = screen.getPrimaryDisplay();
  const { x, y, width, height } = primary.bounds;

  console.log('Pre-creating reusable cropper window');

  const win = new BrowserWindow({
    width: width,
    height: height,
    x: x,
    y: y,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    focusable: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  cropperWindow = win;

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true);
  win.setContentProtection(true);

  win.loadFile('cropper.html');

  win.webContents.on('did-finish-load', () => {
    console.log('✓ Cropper HTML loaded (ready for instant crop)');
  });

  win.on('closed', () => {
    if (cropperWindow === win) cropperWindow = null;
  });

  return win;
}

// Show cropper and get selection
function showCropper() {
  return new Promise((resolve) => {
    const win = createCropperWindow(); // ensures it exists (creates only if missing)

    const targetScreen = getOverlayScreen();
    const screenBounds = targetScreen.bounds;

    // Reposition the reusable window onto whichever screen the overlay is on
    win.setBounds({
      x: screenBounds.x,
      y: screenBounds.y,
      width: screenBounds.width,
      height: screenBounds.height
    });

    cropperWindow = win;
    cropperWindow.setIgnoreMouseEvents(false);
    cropperWindow.show();
    cropperWindow.focus();
    cropperWindow.setAlwaysOnTop(true, 'screen-saver');
    cropperWindow.moveTop();

    console.log('Cropper visible, waiting for selection...');
    
    cropperWindow.webContents.send('screen-bounds', {
      x: screenBounds.x,
      y: screenBounds.y,
      width: screenBounds.width,
      height: screenBounds.height
    });
    
    const selectionHandler = (event, relativeBounds) => {
      console.log('Selection received (relative):', relativeBounds);
      cleanup();
      if (cropperWindow && !cropperWindow.isDestroyed()) cropperWindow.hide();
      const absoluteBounds = {
        x: relativeBounds.x + screenBounds.x,
        y: relativeBounds.y + screenBounds.y,
        width: relativeBounds.width,
        height: relativeBounds.height
      };
      resolve(absoluteBounds);
    };
    
    const cancelHandler = () => {
      console.log('Selection cancelled');
      cleanup();
      if (cropperWindow && !cropperWindow.isDestroyed()) cropperWindow.hide();
      resolve(null);
    };
    
    function cleanup() {
      ipcMain.removeListener('crop-selection', selectionHandler);
      ipcMain.removeListener('crop-cancel', cancelHandler);
    }
    
    ipcMain.once('crop-selection', selectionHandler);
    ipcMain.once('crop-cancel', cancelHandler);
  });
}

// Create system tray icon so the app is accessible without taskbar
function createTray() {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'tray-icon.png')
    : path.join(__dirname, 'assets', 'tray-icon.png');
  let icon;
  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) icon = nativeImage.createEmpty();
  } catch {
    icon = nativeImage.createEmpty();
  }
  try {
    tray = new Tray(icon);
  } catch {
    return;
  }
  tray.setToolTip('AI Assistant');
  const menu = Menu.buildFromTemplate([
    { label: 'Show / Hide', click: () => {
        if (overlayWindow) {
          overlayWindow.isVisible() ? overlayWindow.hide() : overlayWindow.show();
        }
    }},
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => {
    if (overlayWindow) {
      overlayWindow.isVisible() ? overlayWindow.hide() : overlayWindow.show();
    }
  });
}

// Create main UI window
function createMainWindow() {
  const displays = screen.getAllDisplays();
  console.log('Detected displays:', displays.length);
  let targetDisplay = displays.length > 1 ? displays[1] : displays[0];
  const { x, y, width, height } = targetDisplay.bounds;

  overlayWindow = new BrowserWindow({
    width: 800,
    height: 650,
    x: x + (width - 800) / 2,
    y: y + (height - 650) / 2,
    transparent: false,
    frame: true,
    alwaysOnTop: true,
    show: true,
    skipTaskbar: true,
    backgroundColor: '#1a1a2e',
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });

  overlayWindow.setContentProtection(true);
  overlayWindow.setSkipTaskbar(true);
  // Elevate to the highest always-on-top band so we sit above fullscreen apps
  // (constructor's alwaysOnTop:true only uses the 'floating' level, which loses to fullscreen windows)
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  overlayWindow.loadFile('gemini-ui.html');
  console.log('✓ Main window created');
}

// Capture using crop selection
async function captureWithCrop() {
  console.log('🎯 Activating crop mode...');
  const targetScreen = getOverlayScreen();
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide();
  const bounds = await showCropper();

  if (!bounds) {
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.show();
    if (overlayWindow) overlayWindow.webContents.send('screenshot-error', 'Selection cancelled');
    return;
  }

  console.log('Absolute bounds:', bounds);
  try {
    // Capture the screen where the selection was made (before showing overlay)
    const screenImage = await captureScreen(targetScreen);

    // Convert absolute screen coordinates to image-relative coordinates
    // screenshot-desktop captures at physical pixels; Electron coords are logical pixels
    const scale = targetScreen.scaleFactor || 1;
    const relativeBounds = {
      x: (bounds.x - targetScreen.bounds.x) * scale,
      y: (bounds.y - targetScreen.bounds.y) * scale,
      width: bounds.width * scale,
      height: bounds.height * scale
    };
    console.log('Scale:', scale, 'Relative bounds:', relativeBounds);

    const croppedImage = cropImage(screenImage, relativeBounds);
    const base64 = croppedImage.toString('base64');
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.show();
    if (overlayWindow) overlayWindow.webContents.send('screenshot-taken', base64, bounds);
    console.log('✓ Cropped screenshot ready');
  } catch (error) {
    console.error('Screenshot error:', error);
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.show();
    if (overlayWindow) overlayWindow.webContents.send('screenshot-error', error.message);
  }
}

async function captureFullScreen() {
  console.log('📸 Capturing full screen of overlay screen...');
  try {
    const targetScreen = getOverlayScreen();
    const screenImage = await captureScreen(targetScreen);
    const base64 = Buffer.from(screenImage).toString('base64');
    if (overlayWindow) overlayWindow.webContents.send('screenshot-taken', base64, null);
    console.log('✓ Full screenshot taken');
  } catch (error) {
    console.error('Screenshot error:', error);
    if (overlayWindow) overlayWindow.webContents.send('screenshot-error', error.message);
  }
}

async function queryOpenRouter(prompt, imageBuffer, model) {
  const selected = model || MODEL;
  // Routing by prefix: "local:" → Ollama, "openai:" → OpenAI direct, else → OpenRouter
  const isLocal = selected.startsWith('local:');
  const isOpenAI = selected.startsWith('openai:');
  let modelName = selected;
  if (isLocal) modelName = selected.slice('local:'.length);
  else if (isOpenAI) modelName = selected.slice('openai:'.length);

  // Local vision models are slow on big images — downscale to cut vision tokens
  // (keeps text readable; dramatically faster). Cloud models keep full resolution.
  let imgBuffer = imageBuffer;
  if (isLocal) {
    const img = nativeImage.createFromBuffer(imageBuffer);
    if (img.getSize().width > 1280) {
      imgBuffer = img.resize({ width: 1280 }).toPNG();
    }
  }
  const base64Image = imgBuffer.toString('base64');

  const requestBody = {
    model: modelName,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Image}` } }
      ]
    }],
    max_tokens: parseInt(process.env.MAX_TOKENS) || 4000,
    temperature: parseFloat(process.env.TEMPERATURE) || 0.7
  };
  // Keep the local model loaded in memory between queries (avoids cold reload)
  if (isLocal) requestBody.keep_alive = '15m';

  let url, apiKey;
  if (isLocal) { url = OLLAMA_URL; }
  else if (isOpenAI) { url = 'https://api.openai.com/v1/chat/completions'; apiKey = OPENAI_API_KEY; }
  else { url = 'https://openrouter.ai/api/v1/chat/completions'; apiKey = OPENROUTER_API_KEY; }

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  try {
    const response = await axios.post(url, requestBody, {
      headers,
      // Local models on CPU/small GPU can be slow — give them more time
      timeout: isLocal ? 180000 : 60000
    });
    return response.data.choices[0].message.content;
  } catch (error) {
    if (isLocal && (error.code === 'ECONNREFUSED' || error.code === 'ECONNABORTED')) {
      return `❌ Could not reach local model at ${url}. Is Ollama running and the model loaded?`;
    }
    if (error.response) {
      return `❌ Error ${error.response.status}: ${JSON.stringify(error.response.data)}`;
    }
    return `❌ Error: ${error.message}`;
  }
}

ipcMain.handle('capture-crop', async () => captureWithCrop());
ipcMain.handle('capture-full', async () => captureFullScreen());
ipcMain.handle('gemini-query', async (event, { question, screenshot, model }) => {
  const selected = model || MODEL;
  const isLocal = selected.startsWith('local:');
  const isOpenAI = selected.startsWith('openai:');
  if (isOpenAI && !OPENAI_API_KEY) return '❌ No OpenAI API key set in .env (OPENAI_API_KEY)';
  if (!isLocal && !isOpenAI && !OPENROUTER_API_KEY) return '❌ No OpenRouter API key set in .env';
  if (!screenshot) return '📸 No screenshot';
  return await queryOpenRouter(question, Buffer.from(screenshot, 'base64'), selected);
});
ipcMain.on('cropper-ready', () => console.log('✓ Cropper ready'));

app.whenReady().then(() => {
  createMainWindow();
  createTray();
  createCropperWindow(); // pre-warm so the first crop is instant
  globalShortcut.register('Alt+Shift+Ctrl+F12', () => captureWithCrop());
  globalShortcut.register('Alt+Shift+Ctrl+F11', () => captureFullScreen());
  globalShortcut.register('Ctrl+Alt+Shift+Delete', () => app.quit());
  // Prevent app from quitting when all windows are closed (keep tray alive)
  app.on('window-all-closed', (e) => e.preventDefault());
  console.log('\n✅ Ready! Use Crop Mode on any screen.\n');
});
app.on('will-quit', () => globalShortcut.unregisterAll());