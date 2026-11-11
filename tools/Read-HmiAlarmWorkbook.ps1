param([Parameter(Mandatory=$true)][string]$Path)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$stream = [IO.File]::Open($Path, 'Open', 'Read', 'Read')
try {
    if ($stream.Length -gt 20000000) { throw 'Alarm workbook exceeds 20 MB.' }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
    $stream.Position = 0
    $zip = New-Object IO.Compression.ZipArchive($stream, [IO.Compression.ZipArchiveMode]::Read, $true)
    try {
        if ($zip.Entries.Count -gt 2000) { throw 'Too many workbook parts.' }
        $total = 0L
        $names = New-Object 'Collections.Generic.HashSet[string]'
        foreach ($entry in $zip.Entries) {
            if (!$names.Add($entry.FullName)) { throw 'Duplicate workbook part.' }
            $total += $entry.Length
        }
        if ($total -gt 80000000) { throw 'Expanded workbook exceeds 80 MB.' }
        function Read-Part([string]$name) {
            $entry = $zip.GetEntry($name)
            if (!$entry -or $entry.Length -gt 20000000) { throw "Missing or oversized workbook part: $name" }
            $settings = New-Object Xml.XmlReaderSettings
            $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
            $settings.XmlResolver = $null
            $settings.MaxCharactersInDocument = 20000000
            $part = $entry.Open()
            try {
                $reader = [Xml.XmlReader]::Create($part, $settings)
                try {
                    $doc = New-Object Xml.XmlDocument
                    $doc.XmlResolver = $null
                    $doc.Load($reader)
                    return ,$doc
                } finally { $reader.Dispose() }
            } finally { $part.Dispose() }
        }
        $strings = New-Object 'Collections.Generic.List[string]'
        if ($zip.GetEntry('xl/sharedStrings.xml')) {
            $shared = Read-Part 'xl/sharedStrings.xml'
            foreach ($si in $shared.SelectNodes('/*[local-name()="sst"]/*[local-name()="si"]')) {
                $value = ($si.SelectNodes('.//*[local-name()="t"]') | ForEach-Object { $_.InnerText }) -join ''
                if ($value.Length -gt 100000 -or $strings.Count -ge 100000) { throw 'Shared string limit exceeded.' }
                $strings.Add($value)
            }
        }
        $rels = Read-Part 'xl/_rels/workbook.xml.rels'
        $targets = @{}
        foreach ($rel in $rels.DocumentElement.ChildNodes) {
            if ($rel.LocalName -ne 'Relationship' -or $rel.GetAttribute('TargetMode') -eq 'External') { continue }
            $target = $rel.GetAttribute('Target')
            if ($target.StartsWith('/xl/')) { $target = $target.Substring(1) }
            else { $target = 'xl/' + $target }
            if ($target -notmatch '^xl/worksheets/[^/\\]+\.xml$') { continue }
            $targets[$rel.GetAttribute('Id')] = $target
        }
        $book = Read-Part 'xl/workbook.xml'
        $sheets = New-Object 'Collections.Generic.List[object]'
        $cellCount = 0
        foreach ($sheet in $book.SelectNodes('/*[local-name()="workbook"]/*[local-name()="sheets"]/*[local-name()="sheet"]')) {
            $id = $sheet.GetAttribute('id', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships')
            if (!$targets.ContainsKey($id)) { throw 'Unsupported worksheet relationship.' }
            $doc = Read-Part $targets[$id]
            $rows = New-Object 'Collections.Generic.List[object]'
            foreach ($row in $doc.SelectNodes('/*[local-name()="worksheet"]/*[local-name()="sheetData"]/*[local-name()="row"]')) {
                if ($rows.Count -ge 10000) { throw 'Workbook row limit exceeded.' }
                $cells = [ordered]@{}
                foreach ($cell in $row.SelectNodes('./*[local-name()="c"]')) {
                    $cellCount++
                    if ($cellCount -gt 200000) { throw 'Workbook cell limit exceeded.' }
                    if ($cell.SelectSingleNode('./*[local-name()="f"]')) { throw 'Formula cells are not accepted as alarm evidence.' }
                    $address = $cell.GetAttribute('r')
                    if ($address -notmatch '^([A-Z]{1,3})[1-9][0-9]*$') { throw 'Invalid cell address.' }
                    $column = $Matches[1]
                    $valueNode = $cell.SelectSingleNode('./*[local-name()="v"]')
                    $value = if ($valueNode) { $valueNode.InnerText } else { '' }
                    if ($cell.GetAttribute('t') -eq 's') {
                        $idx = 0
                        if (![int]::TryParse($value, [ref]$idx) -or $idx -lt 0 -or $idx -ge $strings.Count) { throw 'Invalid shared string reference.' }
                        $value = $strings[$idx]
                    } elseif ($cell.GetAttribute('t') -eq 'inlineStr') {
                        $value = ($cell.SelectNodes('./*[local-name()="is"]//*[local-name()="t"]') | ForEach-Object { $_.InnerText }) -join ''
                    } elseif ($cell.GetAttribute('t') -eq 'e') { throw 'Error cell in alarm workbook.' }
                    if ($value.Length -gt 100000 -or $cells.Contains($column)) { throw 'Invalid or oversized cell.' }
                    $cells[$column] = $value
                }
                $rows.Add(@{ row = [int]$row.GetAttribute('r'); cells = $cells })
            }
            $sheets.Add(@{ name = $sheet.GetAttribute('name'); rows = $rows.ToArray() })
        }
        $result = @{ sha256 = $hash; sheets = $sheets.ToArray() } | ConvertTo-Json -Depth 12 -Compress
        if ($result.Length -gt 8000000) { throw 'Alarm workbook output exceeds 8 MB.' }
        [Console]::WriteLine($result)
    } finally { $zip.Dispose() }
} finally { $stream.Dispose() }
