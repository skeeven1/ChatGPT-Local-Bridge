param(
  [string]$Title = 'ChatGPT Local Bridge',
  [string]$Body = 'Alerte',
  [int]$TimeoutSeconds = 90
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$form.Width = 620
$form.Height = 250
$form.BackColor = [System.Drawing.Color]::FromArgb(18,18,22)
$form.ForeColor = [System.Drawing.Color]::White
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false

$label = New-Object System.Windows.Forms.Label
$label.Left = 28
$label.Top = 28
$label.Width = 548
$label.Height = 110
$label.Font = New-Object System.Drawing.Font('Segoe UI',16,[System.Drawing.FontStyle]::Bold)
$label.Text = $Body
$label.TextAlign = 'MiddleCenter'
$form.Controls.Add($label)

$button = New-Object System.Windows.Forms.Button
$button.Left = 205
$button.Top = 155
$button.Width = 190
$button.Height = 42
$button.Text = "Arreter l'alarme"
$button.Font = New-Object System.Drawing.Font('Segoe UI',11)
$button.Add_Click({ $form.Close() })
$form.Controls.Add($button)

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 900
$timer.Add_Tick({ [System.Media.SystemSounds]::Exclamation.Play() })
$timer.Start()

$timeout = New-Object System.Windows.Forms.Timer
$timeout.Interval = [Math]::Max(5000, [Math]::Min(600000, $TimeoutSeconds * 1000))
$timeout.Add_Tick({ $form.Close() })
$timeout.Start()

$form.Add_Shown({ [System.Media.SystemSounds]::Exclamation.Play(); $form.Activate() })
[void]$form.ShowDialog()
$timer.Stop(); $timeout.Stop()
