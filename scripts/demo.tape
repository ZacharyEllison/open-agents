# VHS tape: open-agent TUI demo → docs/assets/demo.gif
# Records the REAL TUI: welcome screen with shimmer, user types a prompt,
# spinner starts, then we cut. No fake output.
Output docs/assets/demo.gif

Require bun

Set Shell "bash"
Set FontSize 14
Set Width 1200
Set Height 640
Set Theme "Catppuccin Mocha"
Set Padding 24
Set Framerate 24
Set TypingSpeed 50ms
Set PlaybackSpeed 1.0
Set LoopOffset 80%

# Launch the real TUI (no-session so it doesn't pollute history)
Hide
Type "cd /Users/zacharyellison/code/open-agents && open-agent --no-session --no-title" Enter
Sleep 2s
Show

# Let the welcome screen shimmer for a few seconds
Sleep 4s

# Type a realistic prompt
Type "Refactor the auth module to use JWT tokens instead of sessions"

Sleep 1s

# Submit — the spinner starts
Enter

# Show the spinner working for a moment then cut
Sleep 3s
