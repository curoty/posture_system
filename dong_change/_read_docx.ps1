Add-Type -AssemblyName 'WindowsBase'
$docxPath = 'C:\Users\xunyi\Desktop\posture-system\dong_change\改动.docx'
$zip = [System.IO.Compression.ZipFile]::OpenRead($docxPath)
$entry = $zip.Entries | Where-Object { $_.Name -eq 'document.xml' }
$stream = $entry.Open()
$reader = New-Object System.IO.StreamReader($stream)
$content = $reader.ReadToEnd()
$reader.Close()
$zip.Dispose()
$xml = [xml]$content
$ns = @{w='http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
$xml.SelectNodes('//w:t', $ns) | ForEach-Object { $_.InnerText }
