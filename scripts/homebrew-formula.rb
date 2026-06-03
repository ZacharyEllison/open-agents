class OpenAgent < Formula
  desc "A fully local-first coding agent"
  homepage "https://github.com/ZacharyEllison/open-agents"
  version "VERSION"  # replaced by release script
  license "AGPL-3.0-or-later"

  on_macos do
    on_arm do
      url "https://github.com/ZacharyEllison/open-agents/releases/download/vVERSION/open-agent-darwin-arm64"
      sha256 "SHA256"
    end
    on_intel do
      url "https://github.com/ZacharyEllison/open-agents/releases/download/vVERSION/open-agent-darwin-x64"
      sha256 "SHA256"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/ZacharyEllison/open-agents/releases/download/vVERSION/open-agent-linux-x64"
      sha256 "SHA256"
    end
  end

  def install
    bin.install "open-agent-*" => "open-agent"
  end

  test do
    assert_match "open-agent", shell_output("#{bin}/open-agent --version")
  end
end
