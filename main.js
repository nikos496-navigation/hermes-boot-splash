'use strict'

// Hermes 开屏（多环节版）
// · 与 Hermes 本体同时起跑，动画不再自动交棒：由用户点「继续/进入」推进
// · 窗口落在鼠标所在的那块屏；Hermes 主窗口出现后若在另一块屏，窗口跟过去
// · 只负责窗口与状态，文案和分镜都在 splash.html

const { app, BrowserWindow, ipcMain, screen } = require('electron')
const { spawn, execFile } = require('child_process')
const fs = require('fs')
const path = require('path')

const HERMES_EXE =
  process.env.HERMES_EXE ||
  path.join(
    process.env.LOCALAPPDATA || '',
    'hermes',
    'hermes-agent',
    'apps',
    'desktop',
    'release',
    'win-unpacked',
    'Hermes.exe',
  )
const HERMES_PROC = process.env.HERMES_PROC || path.basename(HERMES_EXE, '.exe')
const HERMES_HOME = process.env.HERMES_HOME || path.join(process.env.LOCALAPPDATA || '', 'hermes')

const PREVIEW = process.env.SPLASH_PREVIEW === '1'
const FORCE = process.env.SPLASH_FORCE === '1'
const AUTO_ENTER_MS = Number(process.env.SPLASH_AUTO_MS || 60000) // 就绪后多久没人管就自己进
const HARD_CAP_MS = 180000 // 兜底：三分钟必关
const FADE_MS = 700

let win = null
let watcher = null
let readySent = false
let exiting = false
let autoTimer = null
let curDisplayId = null
const STATE_FILE = path.join(__dirname, 'last-display.json') // 记住上次 Hermes 落在哪块屏

// ---------------------------------------------------------------- 环境信息

function readConfig() {
  try {
    const text = fs.readFileSync(path.join(HERMES_HOME, 'config.yaml'), 'utf8')
    const pick = (key) => {
      const m = text.match(new RegExp('^  ' + key + ':\\s*(.+)$', 'm'))
      return m ? m[1].trim().replace(/^["']|["']$/g, '') : ''
    }
    return { model: pick('default'), provider: pick('provider') }
  } catch {
    return { model: 'unknown', provider: 'unknown' }
  }
}

function countSkills(dir) {
  let n = 0
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const p = path.join(dir, entry.name)
      if (fs.existsSync(path.join(p, 'SKILL.md'))) {
        n++
        continue
      }
      try {
        for (const sub of fs.readdirSync(p, { withFileTypes: true })) {
          if (sub.isDirectory() && fs.existsSync(path.join(p, sub.name, 'SKILL.md'))) n++
        }
      } catch {}
    }
  } catch {}
  return n
}

function kb(file) {
  try {
    return Math.round((fs.statSync(file).size / 1024) * 10) / 10
  } catch {
    return 0
  }
}

function countCron() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(HERMES_HOME, 'cron', 'jobs.json'), 'utf8'))
    const list = Array.isArray(raw) ? raw : raw.jobs || []
    return Array.isArray(list) ? list.length : 0
  } catch {
    return 0
  }
}

function gatherInfo() {
  const cfg = readConfig()
  const profile = HERMES_HOME.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
  return {
    profile: profile === 'hermes' ? 'default' : profile,
    model: cfg.model || 'unknown',
    provider: cfg.provider || 'unknown',
    skills: countSkills(path.join(HERMES_HOME, 'skills')),
    memoryKb: kb(path.join(HERMES_HOME, 'memories', 'MEMORY.md')),
    userKb: kb(path.join(HERMES_HOME, 'memories', 'USER.md')),
    cron: countCron(),
    displays: screen.getAllDisplays().length,
    platform: 'Windows',
  }
}

// ---------------------------------------------------------------- 启动 Hermes

function hermesRunning() {
  return new Promise((resolve) => {
    execFile(
      'tasklist',
      ['/FI', 'IMAGENAME eq ' + HERMES_PROC + '.exe', '/NH'],
      { windowsHide: true, timeout: 4000 },
      (err, stdout) => resolve(!err && new RegExp(HERMES_PROC + '\\.exe', 'i').test(String(stdout || ''))),
    )
  })
}

function launchHermes() {
  const extra = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  try {
    const child = spawn(HERMES_EXE, extra, {
      detached: true,
      stdio: 'ignore',
      cwd: path.dirname(HERMES_EXE),
      windowsHide: false,
    })
    child.on('error', () => {})
    child.unref()
  } catch {}
}

// -------------------------------------------------------- 主窗口位置 / 就绪探测

function windowRectScript() {
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    'Add-Type @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public struct RECT { public int Left, Top, Right, Bottom; }',
    'public class Win32 {',
    '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);',
    '}',
    '"@',
    'for($i=0;$i -lt 250;$i++){',
    '  foreach($p in @(Get-Process -Name ' + HERMES_PROC + ' -ErrorAction SilentlyContinue)){',
    '    if($p.MainWindowHandle -ne 0){',
    '      $r = New-Object RECT',
    '      [Win32]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null',
    '      if(($r.Right - $r.Left) -gt 200){',
    '        Write-Output ("READY {0} {1} {2} {3}" -f $r.Left, $r.Top, ($r.Right-$r.Left), ($r.Bottom-$r.Top))',
    '        exit 0',
    '      }',
    '    }',
    '  }',
    '  Start-Sleep -Milliseconds 120',
    '}',
  ].join('\n')
}

function startReadyWatch() {
  watcher = execFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', windowRectScript()],
    { windowsHide: true },
    (err, stdout) => handleReadyLine(String(stdout || '')),
  )
  watcher.stdout && watcher.stdout.on('data', (d) => handleReadyLine(String(d)))
  watcher.on('error', () => {})
}

function handleReadyLine(text) {
  const m = text.match(/READY\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)/)
  if (!m) return
  const rect = { x: Number(m[1]), y: Number(m[2]), width: Number(m[3]), height: Number(m[4]) }
  if (!readySent) {
    readySent = true
    if (win && !win.isDestroyed() && win.webContents) win.webContents.send('splash:ready')
    startAutoEnter()
  }
  followHermesDisplay(rect)
}

// Hermes 开在哪块屏，开屏就跟到哪块屏
function followHermesDisplay(rect) {
  if (!win || win.isDestroyed()) return
  const center = { x: rect.x + Math.round(rect.width / 2), y: rect.y + Math.round(rect.height / 2) }
  const display = screen.getDisplayNearestPoint(center)
  if (!display || display.id === curDisplayId) return
  curDisplayId = display.id
  try {
    win.setBounds(display.bounds)
  } catch {}
  rememberDisplay(display)
}

// ---------------------------------------------------------------- 关机时机

function startAutoEnter() {
  if (autoTimer) return
  autoTimer = setTimeout(() => exitSplash(), AUTO_ENTER_MS)
}

function exitSplash() {
  if (exiting) return
  exiting = true
  if (autoTimer) clearTimeout(autoTimer)
  if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
    win.webContents.send('splash:done')
  }
  setTimeout(() => app.quit(), FADE_MS)
}

// ---------------------------------------------------------------- 窗口

function launchDisplay() {
  // 上次 Hermes 落在哪块屏，这次就直接开在那儿；没有记录才看鼠标
  if (process.env.SPLASH_IGNORE_MEMORY !== '1') {
    try {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
      const d = screen.getDisplayNearestPoint({ x: saved.x, y: saved.y })
      if (d) return d
    } catch {}
  }
  try {
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  } catch {
    return screen.getPrimaryDisplay()
  }
}

function rememberDisplay(display) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ x: display.bounds.x + 20, y: display.bounds.y + 20 }))
  } catch {}
}

function createWindow() {
  const display = PREVIEW ? screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) : launchDisplay()
  curDisplayId = display.id
  rememberDisplay(display)
  win = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    resizable: false,
    movable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    enableLargerThanScreen: true,
    backgroundColor: '#0d1117',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })

  win.setAlwaysOnTop(true, 'screen-saver')
  win.once('ready-to-show', () => {
    if (!win || win.isDestroyed()) return
    // 有些屏（竖屏/高缩放）创建时会被系统压扁，显式再贴一次
    try {
      win.setBounds(display.bounds)
    } catch {}
    win.show()
    win.focus()
  })
  win.loadFile(path.join(__dirname, 'splash.html'), PREVIEW ? { search: 'preview=1' } : undefined)
}

ipcMain.handle('splash:info', () => gatherInfo())
ipcMain.on('splash:exit', () => exitSplash())

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) win.focus()
  })

  app.whenReady().then(async () => {
    if (PREVIEW) {
      createWindow()
      setTimeout(() => {
        if (win && !win.isDestroyed() && win.webContents) win.webContents.send('splash:ready')
      }, 600)
      return
    }

    if (!FORCE && (await hermesRunning())) {
      // 已经在跑：这次只是唤回窗口，不摆仪式
      launchHermes()
      app.quit()
      return
    }

    createWindow()
    launchHermes()
    startReadyWatch()
    setTimeout(() => exitSplash(), HARD_CAP_MS)
  })
}

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => {
  if (autoTimer) clearTimeout(autoTimer)
  try {
    if (watcher) watcher.kill()
  } catch {}
})
