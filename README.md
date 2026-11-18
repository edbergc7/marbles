<div align="center">

<img src="build/icon.png" alt="Marbles logo" width="96" height="96">

# Marbles

**Describe a small tool. Get a working app. Keep it.**

A desktop app that builds small tools for you with AI and keeps them in a library on your computer.

[![Download](https://img.shields.io/badge/download-latest-ff6b2c)](https://github.com/edbergc7/marbles/releases/latest)
[![License: GPL v3+](https://img.shields.io/badge/license-GPL--3.0--or--later-blue)](LICENSE)
![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

[Download](#download) · [How it works](#how-it-works) · [Privacy](#what-leaves-your-computer) · [Contributing](CONTRIBUTING.md)

<br>

<img src="docs/screenshots/chat.png" alt="Marbles with a text case tool open and the chat showing three versions of changes" width="900">

</div>

## Why Marbles

You describe what you need, such as "an image cropper with aspect presets" or "a bill splitter", and a minute later it is a working app in your sidebar. To change it, say what to add or fix. Every change is a new version you can undo.

|                                  |                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 🗂️ **Your tools stay with you**  | Each one is a plain HTML file in a folder on your computer. There is no account and no Marbles server.             |
| 🔑 **Bring your own AI**         | Sign in with a ChatGPT Plus or Pro plan, or add an [OpenRouter](https://openrouter.ai) API key and pick any model. |
| 🛡️ **Tools run in a sandbox**    | A generated tool can't read your files or reach the rest of your computer.                                         |
| ↩️ **Every change is a version** | Step back and forth between versions, or undo a change that went wrong.                                            |
| 📤 **Export anywhere**           | Save any tool as a single HTML file that opens in a browser.                                                       |

## Screenshots

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/new-app.png" alt="The New App screen with a prompt box and suggestions"></td>
    <td width="50%"><img src="docs/screenshots/halftone.png" alt="A generated halftone image tool with sliders"></td>
  </tr>
  <tr>
    <td align="center"><b>Start a tool</b><br>Describe it in a sentence, or pick a suggestion.</td>
    <td align="center"><b>Use it</b><br>Tools share one clean look, with real controls.</td>
  </tr>
</table>

## How it works

1. **Describe it.** Type what you need on the New App screen. You can attach images or documents for reference.
2. **Watch it build.** Marbles shows a short plan and ticks it off as the AI writes the tool. The finished tool appears when it is complete.
3. **Change it.** Open the chat and say what to add or fix. Each change becomes a new version, and your current one stays usable while it builds.
4. **Keep it.** Every tool is saved to your library automatically. Rename it, pin it, sort it into folders, or export it.

## Download

Get the latest version from the [releases page](https://github.com/edbergc7/marbles/releases/latest).

| System                | File                              |
| --------------------- | --------------------------------- |
| Windows               | `marbles-<version>-setup.exe`     |
| Windows, no install   | `marbles-<version>-win-x64.zip`   |
| macOS (Apple silicon) | `marbles-<version>-mac-arm64.dmg` |
| macOS (Intel)         | `marbles-<version>-mac-x64.dmg`   |
| Linux                 | `marbles-<version>.AppImage`      |

> [!NOTE]
> **The builds are not code-signed.** Signing certificates cost money every year and Marbles is free, so your system warns you the first time you open it. The steps below get you past the warning. If you would rather not trust a download, you can [build it from source](CONTRIBUTING.md).

Marbles never installs anything by itself. When a new version is out it shows a banner with a link back to the releases page.

## Install

### Windows

1. Run `marbles-<version>-setup.exe`.
2. Windows shows "Windows protected your PC". Click **More info**, then **Run anyway**.
3. Marbles installs for your account only, with no admin prompt, and opens. It adds a Start menu entry and a desktop shortcut.

To uninstall, use **Settings → Apps**. Your library, settings and API key stay in `%APPDATA%\Marbles`, so reinstalling brings everything back.

**No install:** extract `marbles-<version>-win-x64.zip` to a folder you'll keep, such as `Documents\Marbles`, and run `marbles.exe`. You get the same warning the first time.

### macOS

1. Open the `.dmg` and drag Marbles into Applications.
2. Open Marbles. macOS says it can't verify the app and refuses. Click **Done**.
3. Open **System Settings → Privacy & Security**, scroll down to the message about Marbles and click **Open Anyway**. Confirm with your password or Touch ID.

You only do this once. If macOS says the app "is damaged" instead, clear the download flag and open it again:

```bash
xattr -dr com.apple.quarantine /Applications/Marbles.app
```

### Linux

```bash
chmod +x marbles-*.AppImage
./marbles-*.AppImage
```

<details>
<summary><b>"AppImages require FUSE to run."</b></summary>

<br>

Install libfuse2:

```bash
sudo apt install libfuse2t64   # Ubuntu 24.04 and later
sudo apt install libfuse2      # Ubuntu 22.04
```

</details>

<details>
<summary><b>"The SUID sandbox helper binary was found, but is not configured correctly."</b></summary>

<br>

Ubuntu 24.04 and later block the feature Chromium's sandbox is built on unless an app has an AppArmor profile. Give Marbles one. Keep the AppImage in a fixed place such as `~/Applications`, then create `/etc/apparmor.d/marbles` with your own path in it:

```
abi <abi/4.0>,
include <tunables/global>

profile marbles /home/YOU/Applications/marbles-*.AppImage flags=(unconfined) {
  userns,
  include if exists <local/marbles>
}
```

Load it:

```bash
sudo apparmor_parser -r /etc/apparmor.d/marbles
```

Starting Marbles with `--no-sandbox` also gets past the error, but it turns off a layer of protection around the tools Marbles generates. Use the profile.

</details>

<details>
<summary><b>No password keyring</b></summary>

<br>

Without a password keyring (GNOME Keyring or KWallet), Marbles can't store your sign-in or API key encrypted. It asks whether to keep it for the session only or save it unencrypted.

</details>

## What leaves your computer

Marbles has no server, no account, no analytics and no crash reporting. It connects to these places and no others.

**Your AI provider, when you build or change a tool.** Marbles sends your request, and when you change a tool, that tool's current code and your recent messages about it. When you click Fix on an error, the error text goes too. A small extra request names each new tool. This goes to one of:

- **OpenRouter** (`openrouter.ai`), with your API key. Marbles also loads OpenRouter's public list of models.
- **OpenAI** (`auth.openai.com` to sign in, `api.openai.com` to build), if you sign in with ChatGPT.

Marbles doesn't send your other tools, the data you put into them, or anything else on your computer. What the provider does with your requests is covered by its own privacy policy.

**GitHub, twice a day and at startup.** Two plain requests with nothing about you or your tools in them: one for the latest release, one for announcements such as a bug warning. Turn them off in **Settings → Updates**.

**Whatever a tool you made needs.** Tools are sandboxed and can't open network connections themselves. Through Marbles they can:

- load code libraries from `cdnjs.cloudflare.com`, `cdn.jsdelivr.net` and `unpkg.com`, which Marbles keeps a copy of after the first download
- show images from `https` addresses
- fetch data from the public internet if the tool was built to, such as a currency converter fetching rates
- ask your AI provider something if the tool was built to, such as an email rewriter

Tools can't reach your computer or your home or office network unless you allow it in **Settings → Network**.

## Where your things are kept

| System  | Folder                                  |
| ------- | --------------------------------------- |
| Windows | `%APPDATA%\Marbles`                     |
| macOS   | `~/Library/Application Support/Marbles` |
| Linux   | `~/.config/Marbles`                     |

The library (your tools, their versions and chats) is in `library` inside that folder. You can move it in **Settings → Library**, for example into a synced folder. Your API key and ChatGPT sign-in are stored there too, encrypted with your system's keychain.

To remove Marbles completely, uninstall the app and delete that folder. Keep the folder if you want your tools back later.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) covers running Marbles from source, the checks and how releases are made. Bug reports and ideas are welcome in the [issue tracker](https://github.com/edbergc7/marbles/issues).

## License

Marbles is licensed under the [GNU General Public License v3.0 or later](LICENSE).

It includes the Inter typeface, under the [SIL Open Font License](resources/fonts/OFL.txt). The ChatGPT logos in `src/renderer/src/assets/siwc` belong to OpenAI and are not covered by the GPL. Marbles is not affiliated with OpenAI, OpenRouter or GitHub.
