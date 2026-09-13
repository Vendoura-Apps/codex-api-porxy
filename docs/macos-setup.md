# Run the Codex CLI proxy on macOS

Build the project and confirm that `codex login status` succeeds for the same
user that will run the service.

Create `~/Library/LaunchAgents/com.codex-cli-api-proxy.plist`, replacing
`/absolute/path/to/project`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.codex-cli-api-proxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/absolute/path/to/project/dist/server/standalone.js</string>
    <string>3456</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/absolute/path/to/project</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>CODEX_SANDBOX</key>
    <string>read-only</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
```

Load it with:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.codex-cli-api-proxy.plist
```
