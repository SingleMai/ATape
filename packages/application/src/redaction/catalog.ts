/*!
Built-in catalog adapted from ConfabulousDev/confab commit 8082a7ab8d3195ae8fb93545508be49bc4c8f5b7.
MIT License

Copyright (c) 2025 Confab Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
import type { RedactionPattern } from "../redaction.ts"

export const catalog: ReadonlyArray<RedactionPattern> = [
  {
    "name": "Sensitive Field Names",
    "type": "sensitive_field",
    "field_pattern": "(?i)^(password|passwd|secret|api_key|apikey|api_secret|token|auth_token|access_token|refresh_token|private_key|credential|credentials)$"
  },
  {
    "name": "Anthropic API Key",
    "type": "api_key",
    "pattern": "sk-ant-api\\d{2}-[A-Za-z0-9_-]{80,120}"
  },
  {
    "name": "OpenAI API Key",
    "type": "api_key",
    "pattern": "sk-(?:proj-)?[A-Za-z0-9_-]{20,200}"
  },
  {
    "name": "AWS Access Key",
    "type": "aws_key",
    "pattern": "AKIA[0-9A-Z]{16}"
  },
  {
    "name": "AWS Secret Key (config file)",
    "type": "aws_secret",
    "pattern": "aws_secret_access_key\\s*=\\s*([A-Za-z0-9/+=]{40})",
    "capture_group": 1
  },
  {
    "name": "AWS Secret Key (env var style)",
    "type": "aws_secret",
    "pattern": "AWS_SECRET_ACCESS_KEY\\s*=\\s*[\"']?([A-Za-z0-9/+=]{40})[\"']?",
    "capture_group": 1
  },
  {
    "name": "GitHub Personal Access Token (Classic)",
    "type": "github_token",
    "pattern": "ghp_[A-Za-z0-9]{36,255}"
  },
  {
    "name": "GitHub Personal Access Token (Fine-grained)",
    "type": "github_token",
    "pattern": "github_pat_[A-Za-z0-9]{22,255}"
  },
  {
    "name": "GitHub OAuth Token",
    "type": "github_token",
    "pattern": "gho_[A-Za-z0-9]{36,255}"
  },
  {
    "name": "GitHub App Token",
    "type": "github_token",
    "pattern": "(?:ghu|ghs)_[A-Za-z0-9]{36,255}"
  },
  {
    "name": "GitHub Refresh Token",
    "type": "github_token",
    "pattern": "ghr_[A-Za-z0-9]{36,255}"
  },
  {
    "name": "JWT Token",
    "type": "jwt",
    "pattern": "eyJ[A-Za-z0-9_-]+\\.eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+"
  },
  {
    "name": "Bearer Token",
    "type": "bearer_token",
    "pattern": "Bearer\\s+[A-Za-z0-9_.~+/=-]{20,}"
  },
  {
    "name": "RSA Private Key",
    "type": "private_key",
    "pattern": "(?s)-----BEGIN RSA PRIVATE KEY-----.*?-----END RSA PRIVATE KEY-----"
  },
  {
    "name": "EC Private Key",
    "type": "private_key",
    "pattern": "(?s)-----BEGIN EC PRIVATE KEY-----.*?-----END EC PRIVATE KEY-----"
  },
  {
    "name": "OpenSSH Private Key",
    "type": "private_key",
    "pattern": "(?s)-----BEGIN OPENSSH PRIVATE KEY-----.*?-----END OPENSSH PRIVATE KEY-----"
  },
  {
    "name": "Generic Private Key (PKCS#8)",
    "type": "private_key",
    "pattern": "(?s)-----BEGIN PRIVATE KEY-----.*?-----END PRIVATE KEY-----"
  },
  {
    "name": "PostgreSQL Connection String Password",
    "type": "password",
    "pattern": "(postgres(?:ql)?://[^:]+:)([^@\\s]+)(@[^\\s]+)",
    "capture_group": 2
  },
  {
    "name": "MySQL Connection String Password",
    "type": "password",
    "pattern": "(mysql://[^:]+:)([^@\\s]+)(@[^\\s]+)",
    "capture_group": 2
  },
  {
    "name": "MongoDB Connection String Password",
    "type": "password",
    "pattern": "(mongodb(?:\\+srv)?://[^:]+:)([^@\\s]+)(@[^\\s]+)",
    "capture_group": 2
  },
  {
    "name": "Redis Connection String Password",
    "type": "password",
    "pattern": "(redis://[^:/@\\s]*:)([^@\\s]+)(@[^\\s]+)",
    "capture_group": 2
  },
  {
    "name": "Generic URL Password",
    "type": "password",
    "pattern": "(://[^:/@\\s]+:)([^@\\s]+)(@)",
    "capture_group": 2
  },
  {
    "name": "Slack Token",
    "type": "slack_token",
    "pattern": "xox[baprs]-[0-9a-zA-Z-]{10,255}"
  },
  {
    "name": "Slack Rotating Token",
    "type": "slack_token",
    "pattern": "xoxe(?:\\.[a-zA-Z0-9-]+)?-[0-9a-zA-Z-]{10,255}"
  },
  {
    "name": "Slack App-Level Token",
    "type": "slack_token",
    "pattern": "xapp-[0-9a-zA-Z-]{10,255}"
  },
  {
    "name": "Stripe Secret API Key",
    "type": "stripe_key",
    "pattern": "sk_(?:live|test)_[0-9a-zA-Z]{24,}"
  },
  {
    "name": "Stripe Restricted API Key",
    "type": "stripe_key",
    "pattern": "rk_(?:live|test)_[0-9a-zA-Z]{24,}"
  },
  {
    "name": "Google API Key",
    "type": "google_api_key",
    "pattern": "AIza[0-9A-Za-z_-]{35}"
  },
  {
    "name": "Twilio API Key",
    "type": "twilio_key",
    "pattern": "SK[0-9a-fA-F]{32}"
  },
  {
    "name": "SendGrid API Key",
    "type": "sendgrid_key",
    "pattern": "SG\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43}"
  },
  {
    "name": "MailChimp API Key",
    "type": "mailchimp_key",
    "pattern": "[0-9a-f]{32}-us[0-9]{1,2}"
  },
  {
    "name": "npm Access Token",
    "type": "npm_token",
    "pattern": "npm_[A-Za-z0-9]{36}"
  },
  {
    "name": "PyPI Token",
    "type": "pypi_token",
    "pattern": "pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{70,}"
  },
  {
    "name": "Confab API Key",
    "type": "confab_key",
    "pattern": "cfb_[A-Za-z0-9]{40}"
  }
]
