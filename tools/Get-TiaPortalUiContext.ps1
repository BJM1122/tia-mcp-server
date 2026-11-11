[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ApiDll,

    [ValidateRange(0, 2147483647)]
    [int]$ProcessId = 0,

    [ValidateRange(50, 2000)]
    [int]$MaxNodes = 800,

    [ValidateRange(2, 12)]
    [int]$MaxDepth = 8,

    [ValidateRange(128, 16384)]
    [int]$MaxTextChars = 4096
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$nativeSource = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class TiaUiReadOnlyNative
{
    private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hwnd);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);

    [DllImport("user32.dll")]
    private static extern IntPtr GetParent(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextW(IntPtr hwnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("oleacc.dll")]
    private static extern int AccessibleObjectFromWindow(
        IntPtr hwnd,
        uint objectId,
        ref Guid interfaceId,
        [MarshalAs(UnmanagedType.Interface)] out object accessible);

    public static IntPtr[] GetVisibleWindowsForProcess(int requestedProcessId)
    {
        var result = new List<IntPtr>();
        EnumWindows(delegate(IntPtr hwnd, IntPtr ignored)
        {
            if (!IsWindowVisible(hwnd))
                return true;
            uint processId;
            GetWindowThreadProcessId(hwnd, out processId);
            if (processId == (uint)requestedProcessId)
                result.Add(hwnd);
            return true;
        }, IntPtr.Zero);
        result.Sort(delegate(IntPtr left, IntPtr right)
        {
            return left.ToInt64().CompareTo(right.ToInt64());
        });
        return result.ToArray();
    }

    public static IntPtr[] GetVisibleDescendantWindows(IntPtr parent)
    {
        var result = new List<IntPtr>();
        EnumChildWindows(parent, delegate(IntPtr hwnd, IntPtr ignored)
        {
            if (IsEffectivelyVisibleDescendant(hwnd, parent))
                result.Add(hwnd);
            return true;
        }, IntPtr.Zero);
        result.Sort(delegate(IntPtr left, IntPtr right)
        {
            return left.ToInt64().CompareTo(right.ToInt64());
        });
        return result.ToArray();
    }

    private static bool Intersect(ref Rect current, Rect other)
    {
        current.Left = Math.Max(current.Left, other.Left);
        current.Top = Math.Max(current.Top, other.Top);
        current.Right = Math.Min(current.Right, other.Right);
        current.Bottom = Math.Min(current.Bottom, other.Bottom);
        return current.Right > current.Left && current.Bottom > current.Top;
    }

    private static bool IsEffectivelyVisibleDescendant(IntPtr hwnd, IntPtr root)
    {
        if (!IsWindowVisible(hwnd))
            return false;
        Rect clipped;
        Rect rootRect;
        if (!GetWindowRect(hwnd, out clipped) || !GetWindowRect(root, out rootRect))
            return false;
        if (!Intersect(ref clipped, rootRect))
            return false;

        var current = hwnd;
        for (var depth = 0; depth < 64 && current != IntPtr.Zero && current != root; depth++)
        {
            var parent = GetParent(current);
            if (parent == IntPtr.Zero || !IsWindowVisible(parent))
                return false;
            Rect parentRect;
            if (!GetWindowRect(parent, out parentRect) || !Intersect(ref clipped, parentRect))
                return false;
            current = parent;
        }
        return current == root && clipped.Right > clipped.Left && clipped.Bottom > clipped.Top;
    }

    public static int GetProcessIdForWindow(IntPtr hwnd)
    {
        uint processId;
        GetWindowThreadProcessId(hwnd, out processId);
        return (int)processId;
    }

    public static string GetWindowTitle(IntPtr hwnd)
    {
        var text = new StringBuilder(4096);
        GetWindowTextW(hwnd, text, text.Capacity);
        return text.ToString();
    }

    public static object GetClientAccessibleObject(IntPtr hwnd)
    {
        var iid = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");
        object accessible;
        var hr = AccessibleObjectFromWindow(hwnd, 0xFFFFFFFCu, ref iid, out accessible);
        if (hr < 0)
            Marshal.ThrowExceptionForHR(hr);
        return accessible;
    }
}
'@

function Convert-ToCleanString {
    param([object]$Value)
    if ($null -eq $Value) {
        return $null
    }
    $text = [string]$Value
    $text = $text.Replace([string][char]0, '').Trim()
    if ([string]::IsNullOrWhiteSpace($text)) {
        return $null
    }
    if ($text.Length -gt $MaxTextChars) {
        return $text.Substring(0, $MaxTextChars)
    }
    return $text
}

function Get-AccessibleValue {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Accessible,
        [Parameter(Mandatory = $true)]
        [int]$ChildId,
        [Parameter(Mandatory = $true)]
        [ValidateSet('Name', 'Value', 'Description', 'Role', 'State')]
        [string]$Property
    )
    try {
        switch ($Property) {
            'Name' { return $Accessible.accName($ChildId) }
            'Value' { return $Accessible.accValue($ChildId) }
            'Description' { return $Accessible.accDescription($ChildId) }
            'Role' { return $Accessible.accRole($ChildId) }
            'State' { return $Accessible.accState($ChildId) }
        }
    }
    catch {
        return $null
    }
    return $null
}

function New-AccessibleNode {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Accessible,
        [int]$ChildId = 0,
        [int]$Depth = 0
    )
    return [pscustomobject]@{
        Accessible = $Accessible
        ChildId = $ChildId
        Depth = $Depth
    }
}

function Get-AccessibleChildren {
    param([Parameter(Mandatory = $true)][object]$Node)
    $children = New-Object System.Collections.Generic.List[object]
    if ($Node.ChildId -ne 0) {
        return $children
    }
    $count = 0
    try {
        $count = [int]$Node.Accessible.accChildCount
    }
    catch {
        return $children
    }
    if ($count -lt 0) {
        return $children
    }
    $boundedCount = [Math]::Min($count, $MaxNodes)
    for ($childId = 1; $childId -le $boundedCount; $childId++) {
        $childObject = $null
        try {
            $childObject = $Node.Accessible.accChild($childId)
        }
        catch {
            $childObject = $null
        }
        if ($null -ne $childObject -and [System.Runtime.InteropServices.Marshal]::IsComObject($childObject)) {
            $children.Add((New-AccessibleNode -Accessible $childObject -Depth ($Node.Depth + 1)))
        }
        else {
            $children.Add((New-AccessibleNode -Accessible $Node.Accessible -ChildId $childId -Depth ($Node.Depth + 1)))
        }
    }
    return $children
}

function Find-AccessibleNodesByName {
    param(
        [Parameter(Mandatory = $true)]
        [object]$RootAccessible,
        [Parameter(Mandatory = $true)]
        [string]$NamePattern,
        [int]$ResultLimit = 20,
        [int]$NodeLimit = $MaxNodes,
        [int]$DepthLimit = $MaxDepth,
        [switch]$StopAfterFirst
    )
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue((New-AccessibleNode -Accessible $RootAccessible))
    $found = New-Object System.Collections.Generic.List[object]
    $visitedCount = 0
    while ($queue.Count -gt 0 -and $visitedCount -lt $NodeLimit -and $found.Count -lt $ResultLimit) {
        $node = $queue.Dequeue()
        $visitedCount++
        $name = Convert-ToCleanString (Get-AccessibleValue -Accessible $node.Accessible -ChildId $node.ChildId -Property Name)
        if ($null -ne $name -and $name -match $NamePattern) {
            $found.Add($node)
            if ($StopAfterFirst) {
                break
            }
        }
        if ($node.Depth -ge $DepthLimit) {
            continue
        }
        foreach ($child in (Get-AccessibleChildren -Node $node)) {
            if (($queue.Count + $visitedCount) -ge $NodeLimit) {
                break
            }
            $queue.Enqueue($child)
        }
    }
    return $found
}

function Find-AccessibleNodesByNamePruned {
    param(
        [Parameter(Mandatory = $true)]
        [object]$RootAccessible,
        [Parameter(Mandatory = $true)]
        [string]$NamePattern,
        [Parameter(Mandatory = $true)]
        [string]$TraverseNamePattern,
        [int]$ResultLimit = 8,
        [int]$NodeLimit = 80,
        [int]$DepthLimit = $MaxDepth
    )
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue((New-AccessibleNode -Accessible $RootAccessible))
    $found = New-Object System.Collections.Generic.List[object]
    $visitedCount = 0
    while ($queue.Count -gt 0 -and $visitedCount -lt $NodeLimit -and $found.Count -lt $ResultLimit) {
        $node = $queue.Dequeue()
        $visitedCount++
        $name = Convert-ToCleanString (Get-AccessibleValue -Accessible $node.Accessible -ChildId $node.ChildId -Property Name)
        if ($null -ne $name -and $name -match $NamePattern) {
            $found.Add($node)
            continue
        }
        if ($node.Depth -ge $DepthLimit) {
            continue
        }
        foreach ($child in (Get-AccessibleChildren -Node $node)) {
            $childName = Convert-ToCleanString (Get-AccessibleValue -Accessible $child.Accessible -ChildId $child.ChildId -Property Name)
            if ($null -ne $childName -and
                ($childName -match $NamePattern -or $childName -match $TraverseNamePattern)) {
                $queue.Enqueue($child)
            }
        }
    }
    return $found
}

function Get-AccessibleCandidate {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Node,
        [Parameter(Mandatory = $true)]
        [string]$Source
    )
    $name = Convert-ToCleanString (Get-AccessibleValue -Accessible $Node.Accessible -ChildId $Node.ChildId -Property Name)
    $value = Convert-ToCleanString (Get-AccessibleValue -Accessible $Node.Accessible -ChildId $Node.ChildId -Property Value)
    $description = Convert-ToCleanString (Get-AccessibleValue -Accessible $Node.Accessible -ChildId $Node.ChildId -Property Description)
    $text = $value
    if ($null -ne $value -and $value -match '(?:^|;)Text=([^;]*)') {
        $text = Convert-ToCleanString $Matches[1]
    }
    if ($null -eq $text) {
        $text = $name
    }
    return [pscustomobject]@{
        text = $text
        label = $text
        source = $Source
        description = $description
    }
}

function Get-ProjectTreeSelection {
    param([Parameter(Mandatory = $true)][object]$RootAccessible)
    $result = [ordered]@{
        status = 'unavailable'
        text = $null
        label = $null
        source = 'project_navigator_msaa'
        candidates = @()
    }
    $treeSearchRoot = $RootAccessible
    $rootName = Convert-ToCleanString (Get-AccessibleValue -Accessible $RootAccessible -ChildId 0 -Property Name)
    if ($rootName -notmatch 'ProjectNavigatorViewFrame$') {
        $navigationContainers = @(Find-AccessibleNodesByName -RootAccessible $RootAccessible -NamePattern '^ApplicationNavigationContainer$' -ResultLimit 1 -NodeLimit 250 -DepthLimit 4 -StopAfterFirst)
        if ($navigationContainers.Count -eq 1) {
            $treeSearchRoot = $navigationContainers[0].Accessible
        }
    }
    $trees = @(Find-AccessibleNodesByName -RootAccessible $treeSearchRoot -NamePattern '^ProjectNavigationTree$' -ResultLimit 1 -NodeLimit 400 -DepthLimit 7 -StopAfterFirst)
    if ($trees.Count -eq 0) {
        return $result
    }
    $selection = $null
    try {
        $selection = $trees[0].Accessible.accSelection
    }
    catch {
        return $result
    }
    $nodes = New-Object System.Collections.Generic.List[object]
    if ($selection -is [System.Array]) {
        foreach ($entry in @($selection | Select-Object -First 20)) {
            if ($entry -is [int] -or $entry -is [long] -or $entry -is [short]) {
                $selectionChildId = [int]$entry
                if ($selectionChildId -gt 0) {
                    $nodes.Add((New-AccessibleNode -Accessible $trees[0].Accessible -ChildId $selectionChildId))
                }
            }
            elseif ($null -ne $entry -and [System.Runtime.InteropServices.Marshal]::IsComObject($entry)) {
                $nodes.Add((New-AccessibleNode -Accessible $entry))
            }
        }
    }
    elseif ($selection -is [int] -or $selection -is [long] -or $selection -is [short]) {
        $selectionChildId = [int]$selection
        if ($selectionChildId -gt 0) {
            $nodes.Add((New-AccessibleNode -Accessible $trees[0].Accessible -ChildId $selectionChildId))
        }
    }
    elseif ($null -ne $selection -and [System.Runtime.InteropServices.Marshal]::IsComObject($selection)) {
        $variantEnumerator = $null
        try {
            $variantEnumerator = [System.Runtime.InteropServices.ComTypes.IEnumVARIANT]$selection
        }
        catch {
            $variantEnumerator = $null
        }
        if ($null -ne $variantEnumerator) {
            try {
                [void]$variantEnumerator.Reset()
                for ($selectionIndex = 0; $selectionIndex -lt 20; $selectionIndex++) {
                    $values = New-Object object[] 1
                    $nextResult = $variantEnumerator.Next(1, $values, [IntPtr]::Zero)
                    if ($nextResult -ne 0) {
                        break
                    }
                    $entry = $values[0]
                    if ($entry -is [int] -or $entry -is [long] -or $entry -is [short]) {
                        $selectionChildId = [int]$entry
                        if ($selectionChildId -gt 0) {
                            $nodes.Add((New-AccessibleNode -Accessible $trees[0].Accessible -ChildId $selectionChildId))
                        }
                    }
                    elseif ($null -ne $entry -and [System.Runtime.InteropServices.Marshal]::IsComObject($entry)) {
                        $nodes.Add((New-AccessibleNode -Accessible $entry))
                    }
                }
            }
            catch {
                return $result
            }
        }
        else {
            $nodes.Add((New-AccessibleNode -Accessible $selection))
        }
    }
    $candidates = @($nodes | ForEach-Object {
        Get-AccessibleCandidate -Node $_ -Source 'project_navigator_msaa'
    } | Where-Object { $null -ne $_.text } | Select-Object -First 20)
    $result.candidates = @($candidates | ForEach-Object {
        [pscustomobject]@{ text = $_.text; label = $_.label; source = $_.source }
    })
    if ($nodes.Count -gt 1) {
        $result.status = 'ambiguous'
    }
    elseif ($candidates.Count -eq 1) {
        $result.status = 'resolved'
        $result.text = $candidates[0].text
        $result.label = $candidates[0].label
    }
    elseif ($candidates.Count -gt 1) {
        $result.status = 'ambiguous'
    }
    return $result
}

function Get-ActiveEditor {
    param([Parameter(Mandatory = $true)][object]$RootAccessible)
    $result = [ordered]@{
        status = 'unavailable'
        text = $null
        label = $null
        breadcrumb = $null
        editorState = $null
        source = 'editor_frame_msaa'
        candidates = @()
    }
    $rootNode = New-AccessibleNode -Accessible $RootAccessible
    $rootName = Convert-ToCleanString (Get-AccessibleValue -Accessible $RootAccessible -ChildId 0 -Property Name)
    if ($null -ne $rootName -and $rootName -match 'EditorFrame$') {
        $frames = @($rootNode)
    }
    else {
        $editorSearchRoot = $RootAccessible
        $mainAndInspectorFrames = @(Find-AccessibleNodesByName -RootAccessible $RootAccessible -NamePattern '^EditorMainAndInspectorFrame$' -ResultLimit 1 -NodeLimit 250 -DepthLimit 4 -StopAfterFirst)
        if ($mainAndInspectorFrames.Count -eq 1) {
            $editorSearchRoot = $mainAndInspectorFrames[0].Accessible
        }
        $editorMainFrames = @(Find-AccessibleNodesByName -RootAccessible $editorSearchRoot -NamePattern '^EditorMainFrame$' -ResultLimit 1 -NodeLimit 250 -DepthLimit 5 -StopAfterFirst)
        if ($editorMainFrames.Count -eq 1) {
            $editorSearchRoot = $editorMainFrames[0].Accessible
        }
        $frames = @(Find-AccessibleNodesByName -RootAccessible $editorSearchRoot -NamePattern 'EditorFrame$' -ResultLimit 12 -NodeLimit 400 -DepthLimit 6)
    }
    $editorCandidates = New-Object System.Collections.Generic.List[object]
    foreach ($frame in $frames) {
        $stateValue = Get-AccessibleValue -Accessible $frame.Accessible -ChildId $frame.ChildId -Property State
        $state = 0
        try { $state = [int]$stateValue } catch { $state = 0 }
        if (($state -band 32768) -ne 0) {
            continue
        }
        $description = Convert-ToCleanString (Get-AccessibleValue -Accessible $frame.Accessible -ChildId $frame.ChildId -Property Description)
        if ($null -eq $description -or $description -notmatch '(?:^|;)Text=([^;]+)') {
            continue
        }
        $breadcrumb = Convert-ToCleanString $Matches[1]
        if ($null -eq $breadcrumb) {
            continue
        }
        $editorState = $null
        if ($description -match '(?:^|;)EditorState=([^;]+)') {
            $editorState = Convert-ToCleanString $Matches[1]
        }
        $editorCandidates.Add([pscustomobject]@{
            text = $breadcrumb
            label = $breadcrumb
            breadcrumb = $breadcrumb
            editorState = $editorState
            source = 'editor_frame_msaa'
            node = $frame
        })
    }
    $result.candidates = @($editorCandidates | ForEach-Object {
        [pscustomobject]@{ text = $_.text; label = $_.label; source = $_.source }
    })
    if ($editorCandidates.Count -eq 1) {
        $selected = $editorCandidates[0]
        $result.status = 'resolved'
        $result.text = $selected.text
        $result.label = $selected.label
        $result.breadcrumb = $selected.breadcrumb
        $result.editorState = $selected.editorState
        $result['node'] = $selected.node
    }
    elseif ($editorCandidates.Count -gt 1) {
        $result.status = 'ambiguous'
    }
    return $result
}

function Get-SelectedNetworkOrSection {
    param([object]$EditorNode)
    $result = [ordered]@{
        status = 'unavailable'
        label = $null
        number = $null
        source = 'network_container_msaa'
        candidates = @()
    }
    if ($null -eq $EditorNode) {
        return $result
    }
    $containers = @(Find-AccessibleNodesByNamePruned `
        -RootAccessible $EditorNode.Accessible `
        -NamePattern '^NetworkContainer$' `
        -TraverseNamePattern '^(?:S7CodeBlockEditorPageFrame.*|PLFrame_CodeContainer|Siemens\.Simatic\.PlcLanguages\.PLFrame\..*Editor|ViewID_.*Editor|HostElement|CodePartControl)$' `
        -ResultLimit 2 `
        -NodeLimit 60 `
        -DepthLimit 8)
    if ($containers.Count -eq 0) {
        return $result
    }
    $selectedLabels = New-Object System.Collections.Generic.List[object]
    $containerOrdinal = 0
    foreach ($container in $containers) {
        $containerOrdinal++
        $labels = New-Object System.Collections.Generic.List[object]
        $containerNode = New-AccessibleNode -Accessible $container.Accessible -ChildId $container.ChildId
        foreach ($networkNode in (Get-AccessibleChildren -Node $containerNode)) {
            $networkName = Convert-ToCleanString (Get-AccessibleValue -Accessible $networkNode.Accessible -ChildId $networkNode.ChildId -Property Name)
            if ($null -eq $networkName -or $networkName -notmatch '^NetworkControlFor') {
                continue
            }
            foreach ($headerNode in (Get-AccessibleChildren -Node $networkNode)) {
                $headerName = Convert-ToCleanString (Get-AccessibleValue -Accessible $headerNode.Accessible -ChildId $headerNode.ChildId -Property Name)
                if ($headerName -ne 'HeaderControl') {
                    continue
                }
                foreach ($labelNode in (Get-AccessibleChildren -Node $headerNode)) {
                    $labelName = Convert-ToCleanString (Get-AccessibleValue -Accessible $labelNode.Accessible -ChildId $labelNode.ChildId -Property Name)
                    if ($labelName -eq 'PLNetworkID') {
                        $labels.Add($labelNode)
                    }
                }
            }
        }
        foreach ($labelNode in $labels) {
            $stateValue = Get-AccessibleValue -Accessible $labelNode.Accessible -ChildId $labelNode.ChildId -Property State
            $state = 0
            try { $state = [int]$stateValue } catch { $state = 0 }
            if (($state -band 2) -eq 0) {
                continue
            }
            $candidate = Get-AccessibleCandidate -Node $labelNode -Source ('network_container_msaa:' + $containerOrdinal)
            if ($null -eq $candidate.text) {
                continue
            }
            $selectedLabels.Add($candidate)
        }
    }
    $result.candidates = @($selectedLabels | ForEach-Object {
        [pscustomobject]@{ text = $_.text; label = $_.label; source = $_.source }
    })
    if ($selectedLabels.Count -eq 1) {
        $result.status = 'resolved'
        $result.label = $selectedLabels[0].label
        if ($selectedLabels[0].label -match '(\d+)(?!.*\d)') {
            $result.number = $Matches[1]
        }
    }
    elseif ($selectedLabels.Count -gt 1) {
        $result.status = 'ambiguous'
    }
    return $result
}

function New-BaseResult {
    return [ordered]@{
        schemaVersion = '1.0'
        observedAt = [DateTime]::UtcNow.ToString('o')
        status = 'error'
        selectedProcessId = $null
        foregroundProcessId = $null
        foregroundWindowHandle = $null
        processes = @()
        selectedObject = [ordered]@{
            status = 'unavailable'; text = $null; label = $null
            source = 'project_navigator_msaa'; candidates = @()
        }
        activeEditor = [ordered]@{
            status = 'unavailable'; text = $null; label = $null; breadcrumb = $null
            editorState = $null; source = 'editor_frame_msaa'; candidates = @()
        }
        networkOrSection = [ordered]@{
            status = 'unavailable'; label = $null; number = $null
            source = 'network_container_msaa'; candidates = @()
        }
        limitations = @(
            'TIA Portal does not expose an official passive getter for ordinary left-click selection, active PLC editor, or active network.',
            'Project tree, editor, and network evidence uses undocumented Windows MSAA names and can be unavailable after a TIA UI/version/editor change.',
            'Mouse hover is not observed.',
            'The probe is on-demand only and does not attach to TIA, invoke UI controls, change focus, poll, capture the screen, or access PLC runtime state.'
        )
    }
}

$output = New-BaseResult
try {
    if (-not (Test-Path -LiteralPath $ApiDll -PathType Leaf)) {
        throw [System.IO.FileNotFoundException]::new('Siemens.Engineering.dll was not found.', $ApiDll)
    }

    Add-Type -TypeDefinition $nativeSource -Language CSharp

    $apiVersionDirectory = Split-Path -Parent $ApiDll
    $publicApiDirectory = Split-Path -Parent $apiVersionDirectory
    $portalDirectory = Split-Path -Parent $publicApiDirectory
    $contractDll = Join-Path $portalDirectory 'Bin\PublicAPI\Siemens.Engineering.Contract.dll'
    if (Test-Path -LiteralPath $contractDll -PathType Leaf) {
        [void][Reflection.Assembly]::LoadFrom($contractDll)
    }
    [void][Reflection.Assembly]::LoadFrom($ApiDll)

    $foregroundWindow = [TiaUiReadOnlyNative]::GetForegroundWindow()
    $foregroundProcessId = 0
    if ($foregroundWindow -ne [IntPtr]::Zero) {
        $foregroundProcessId = [TiaUiReadOnlyNative]::GetProcessIdForWindow($foregroundWindow)
        $output.foregroundWindowHandle = $foregroundWindow.ToInt64()
        if ($foregroundProcessId -gt 0) {
            $output.foregroundProcessId = $foregroundProcessId
        }
    }

    $diagnosticProcesses = @([Siemens.Engineering.TiaPortal]::GetProcesses())
    $processRecords = New-Object System.Collections.Generic.List[object]
    foreach ($diagnosticProcess in $diagnosticProcesses) {
        $portalProcessId = [int]$diagnosticProcess.Id
        $osProcess = $null
        $processStartTimeUtc = $null
        try {
            $osProcess = [System.Diagnostics.Process]::GetProcessById($portalProcessId)
            $processStartTimeUtc = $osProcess.StartTime.ToUniversalTime().ToString('o')
        }
        catch {
            $osProcess = $null
            $processStartTimeUtc = $null
        }
        $visibleWindows = @([TiaUiReadOnlyNative]::GetVisibleWindowsForProcess($portalProcessId))
        $mainWindow = [IntPtr]::Zero
        if ($visibleWindows.Count -gt 0) {
            $processMainWindow = [IntPtr]::Zero
            if ($null -ne $osProcess) {
                try {
                    $processMainWindow = $osProcess.MainWindowHandle
                }
                catch {
                    $processMainWindow = [IntPtr]::Zero
                }
            }
            $mainWindowMatch = @($visibleWindows | Where-Object { $_ -eq $processMainWindow })
            if ($mainWindowMatch.Count -eq 1) {
                $mainWindow = $mainWindowMatch[0]
            }
            else {
                $foregroundMatch = @($visibleWindows | Where-Object { $_ -eq $foregroundWindow })
                if ($foregroundMatch.Count -eq 1) {
                    $mainWindow = $foregroundMatch[0]
                }
            }
            if ($mainWindow -eq [IntPtr]::Zero) {
                $titled = @($visibleWindows | ForEach-Object {
                    [pscustomobject]@{
                        hwnd = $_
                        title = Convert-ToCleanString ([TiaUiReadOnlyNative]::GetWindowTitle($_))
                    }
                } | Where-Object { $null -ne $_.title } | Sort-Object @{ Expression = { $_.title.Length }; Descending = $true }, @{ Expression = { $_.hwnd.ToInt64() }; Descending = $false })
                if ($titled.Count -gt 0) {
                    $mainWindow = $titled[0].hwnd
                }
                else {
                    $mainWindow = $visibleWindows[0]
                }
            }
        }
        $projectPath = Convert-ToCleanString $diagnosticProcess.ProjectPath
        $projectName = $null
        if ($null -ne $projectPath) {
            $projectName = Convert-ToCleanString ([System.IO.Path]::GetFileNameWithoutExtension($projectPath))
        }
        $windowTitle = $null
        $windowHandleValue = $null
        $isMinimized = $null
        if ($mainWindow -ne [IntPtr]::Zero) {
            $windowHandleValue = $mainWindow.ToInt64()
            $windowTitle = Convert-ToCleanString ([TiaUiReadOnlyNative]::GetWindowTitle($mainWindow))
            $isMinimized = [TiaUiReadOnlyNative]::IsIconic($mainWindow)
        }
        $processRecords.Add([pscustomobject]@{
            processId = $portalProcessId
            projectName = $projectName
            projectPath = $projectPath
            processStartTimeUtc = $processStartTimeUtc
            mainWindowHandle = $windowHandleValue
            windowTitle = $windowTitle
            isMinimized = $isMinimized
            _mainWindow = $mainWindow
            _isMinimized = $isMinimized
        })
    }
    $output.processes = @($processRecords | ForEach-Object {
        [pscustomobject]@{
            processId = $_.processId
            projectName = $_.projectName
            projectPath = $_.projectPath
            processStartTimeUtc = $_.processStartTimeUtc
            mainWindowHandle = $_.mainWindowHandle
            windowTitle = $_.windowTitle
            isMinimized = $_.isMinimized
        }
    })

    $selectedProcess = $null
    if ($ProcessId -gt 0) {
        $requested = @($processRecords | Where-Object { $_.processId -eq $ProcessId })
        if ($requested.Count -eq 1) {
            $selectedProcess = $requested[0]
        }
        else {
            $output.status = 'none'
            $output.limitations += "The requested process ID was not present in Siemens' TIA diagnostic process snapshot."
        }
    }
    else {
        $visibleRecords = @($processRecords | Where-Object { $null -ne $_.mainWindowHandle })
        if ($visibleRecords.Count -eq 1) {
            $selectedProcess = $visibleRecords[0]
        }
        elseif ($visibleRecords.Count -gt 1) {
            $foregroundRecords = @($visibleRecords | Where-Object { $_.processId -eq $foregroundProcessId })
            if ($foregroundRecords.Count -eq 1) {
                $selectedProcess = $foregroundRecords[0]
            }
            else {
                $output.status = 'multiple'
                $output.limitations += 'Multiple visible TIA sessions were found and the foreground window did not identify exactly one. Pass processId explicitly.'
            }
        }
        else {
            $output.status = 'none'
        }
    }

    if ($null -ne $selectedProcess) {
        $output.status = 'selected'
        $output.selectedProcessId = $selectedProcess.processId
        if ($selectedProcess._mainWindow -eq [IntPtr]::Zero) {
            $output.limitations += 'The selected diagnostic session has no visible main window, so UI context is unavailable.'
        }
        elseif ($selectedProcess._isMinimized) {
            $output.limitations += 'The selected TIA window is minimized. Project identity is current, but hidden editor/selection/network frames are not reported because they may be stale.'
        }
        else {
            try {
                $editorNode = $null
                $descendantWindows = @([TiaUiReadOnlyNative]::GetVisibleDescendantWindows($selectedProcess._mainWindow))
                $descendantWindowRecords = @($descendantWindows | ForEach-Object {
                    [pscustomobject]@{
                        hwnd = $_
                        title = Convert-ToCleanString ([TiaUiReadOnlyNative]::GetWindowTitle($_))
                    }
                } | Where-Object { $null -ne $_.title })

                $projectNavigatorWindows = @($descendantWindowRecords | Where-Object {
                    $_.title -match '^ViewFramePanelControl:\s+Siemens\.Automation\.FrameApplication\.ProjectNavigatorViewFrame$'
                })
                if ($projectNavigatorWindows.Count -eq 1) {
                    $projectNavigatorAccessible = [TiaUiReadOnlyNative]::GetClientAccessibleObject($projectNavigatorWindows[0].hwnd)
                    $output.selectedObject = Get-ProjectTreeSelection -RootAccessible $projectNavigatorAccessible
                }
                elseif ($projectNavigatorWindows.Count -gt 1) {
                    $output.selectedObject.status = 'ambiguous'
                    $output.limitations += 'Multiple visible project navigator windows were found, so no single project-tree selection was chosen.'
                }

                $editorWindows = @($descendantWindowRecords | Where-Object {
                    $_.title -match '^HierarchyFrame:\s+.*EditorFrame$'
                })
                if ($editorWindows.Count -eq 1) {
                    $editorAccessible = [TiaUiReadOnlyNative]::GetClientAccessibleObject($editorWindows[0].hwnd)
                    $activeEditor = Get-ActiveEditor -RootAccessible $editorAccessible
                    if ($activeEditor.Contains('node')) {
                        $editorNode = $activeEditor.node
                        $activeEditor.Remove('node')
                    }
                    $output.activeEditor = $activeEditor
                }
                elseif ($editorWindows.Count -gt 1) {
                    $output.activeEditor.status = 'ambiguous'
                    $visibleEditorCandidates = New-Object System.Collections.Generic.List[object]
                    foreach ($editorWindow in $editorWindows) {
                        try {
                            $editorAccessible = [TiaUiReadOnlyNative]::GetClientAccessibleObject($editorWindow.hwnd)
                            $candidateEditor = Get-ActiveEditor -RootAccessible $editorAccessible
                            foreach ($candidate in @($candidateEditor.candidates)) {
                                $visibleEditorCandidates.Add($candidate)
                            }
                        }
                        catch {
                        }
                    }
                    $output.activeEditor.candidates = @($visibleEditorCandidates)
                    $output.limitations += 'Multiple visible editor frames were found, so no single active editor or network was chosen.'
                }

                $output.networkOrSection = Get-SelectedNetworkOrSection -EditorNode $editorNode
            }
            catch {
                $output.selectedObject.status = 'error'
                $output.activeEditor.status = 'error'
                $output.networkOrSection.status = 'error'
                $output.limitations += ('Windows accessibility read failed: ' + (Convert-ToCleanString $_.Exception.Message))
            }
        }
    }
}
catch {
    $output.status = 'error'
    $output.limitations += ('TIA diagnostic probe failed: ' + (Convert-ToCleanString $_.Exception.Message))
}

$json = $output | ConvertTo-Json -Depth 8 -Compress
[Console]::Out.WriteLine($json)
