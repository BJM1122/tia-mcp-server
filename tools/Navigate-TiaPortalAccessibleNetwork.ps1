[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 2147483647)]
    [int]$ProcessId,

    [Parameter(Mandatory = $true)]
    [ValidateLength(20, 64)]
    [string]$ExpectedProcessStartTimeUtc,

    [Parameter(Mandatory = $true)]
    [ValidateLength(1, 32767)]
    [string]$ExpectedProjectPath,

    [Parameter(Mandatory = $true)]
    [ValidateLength(1, 32767)]
    [string]$ApiDll,

    [Parameter(Mandatory = $true)]
    [ValidateLength(1, 500)]
    [string]$ExactLabel,

    [Parameter(Mandatory = $true)]
    [ValidateLength(1, 50)]
    [string]$OfficialNavigationStatus,

    [Parameter(Mandatory = $true)]
    [ValidateLength(1, 100)]
    [string]$ConfirmNavigation,

    [ValidateRange(500, 15000)]
    [int]$TimeoutMs = 5000,

    [ValidateRange(50, 2000)]
    [int]$MaxNodes = 800,

    [ValidateRange(2, 12)]
    [int]$MaxDepth = 8,

    [ValidateRange(1, 10)]
    [int]$MaxAttempts = 4,

    [ValidateRange(25, 500)]
    [int]$AttemptDelayMs = 150
)

$ErrorActionPreference = 'Stop'
$operationStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$deadlineReached = $false
$nodesVisited = 0
$limitReached = $false
$depthLimitReached = $false
$enumerationIncomplete = $false
$searchStarted = $false
$searchCompleted = $false
$attemptsCompleted = 0
$interactionWasAttempted = $false
$actionsTaken = @()
$sessionVerificationRecords = @()
$officialApiLoaded = $false
$officialApiVersion = $null
$expectedProcessStartUtcTicks = $null
$canonicalExpectedProjectPath = $null
$canonicalApiDll = $null

function Test-Deadline {
    if ($operationStopwatch.ElapsedMilliseconds -ge $TimeoutMs) {
        $script:deadlineReached = $true
        return $true
    }
    return $false
}

function Resolve-CanonicalProjectPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        throw [System.ArgumentException]::new('ExpectedProjectPath must not be empty.')
    }
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    if (-not [string]::Equals(
        [System.IO.Path]::GetExtension($fullPath),
        '.ap20',
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        throw [System.ArgumentException]::new('ExpectedProjectPath must identify a canonical TIA Portal V20 .ap20 project file.')
    }
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        throw [System.IO.FileNotFoundException]::new('ExpectedProjectPath does not identify an existing .ap20 project file.', $fullPath)
    }
    $resolved = (Resolve-Path -LiteralPath $fullPath -ErrorAction Stop).ProviderPath
    return [System.IO.Path]::GetFullPath([string]$resolved)
}

function Initialize-OfficialApi {
    if ($script:officialApiLoaded) {
        return
    }
    if ([string]::IsNullOrWhiteSpace($script:canonicalApiDll) -or
        -not (Test-Path -LiteralPath $script:canonicalApiDll -PathType Leaf)) {
        throw [System.IO.FileNotFoundException]::new('ApiDll must identify an existing Siemens.Engineering.dll file.', $script:canonicalApiDll)
    }

    $apiAssemblyName = [System.Reflection.AssemblyName]::GetAssemblyName($script:canonicalApiDll)
    if ($null -eq $apiAssemblyName.Version -or $apiAssemblyName.Version.Major -ne 20) {
        throw [System.NotSupportedException]::new('The accessibility fallback requires the Siemens TIA Portal V20 Openness API.')
    }

    $apiVersionDirectory = Split-Path -Parent $script:canonicalApiDll
    $publicApiDirectory = Split-Path -Parent $apiVersionDirectory
    $portalDirectory = Split-Path -Parent $publicApiDirectory
    $contractDll = Join-Path $portalDirectory 'Bin\PublicAPI\Siemens.Engineering.Contract.dll'
    if (Test-Path -LiteralPath $contractDll -PathType Leaf) {
        [void][System.Reflection.Assembly]::LoadFrom($contractDll)
    }
    [void][System.Reflection.Assembly]::LoadFrom($script:canonicalApiDll)
    $script:officialApiVersion = $apiAssemblyName.Version.ToString()
    $script:officialApiLoaded = $true
}

function Test-ExactPortalSession {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet('before_enumeration', 'before_interaction', 'after_interaction')]
        [string]$Phase
    )

    $record = [ordered]@{
        phase = $Phase
        ok = $false
        status = 'session_mismatch'
        reason = ''
        processId = $ProcessId
        processNameMatch = $false
        processStartTimeMatch = $false
        officialProcessMatchCount = 0
        projectPathMatch = $false
        officialApiVersion = $script:officialApiVersion
        observedAtUtc = [DateTime]::UtcNow.ToString('o')
    }

    try {
        if (Test-Deadline) {
            $record.status = 'partial'
            $record.reason = 'The strict navigation deadline expired before the exact Portal session could be revalidated.'
            return [pscustomobject]$record
        }

        $process = Get-Process -Id $ProcessId -ErrorAction Stop
        $process.Refresh()
        if ($process.HasExited) {
            $record.reason = 'The exact Portal process exited before session validation completed.'
            return [pscustomobject]$record
        }
        $record.processNameMatch = [string]::Equals(
            [string]$process.ProcessName,
            'Siemens.Automation.Portal',
            [System.StringComparison]::OrdinalIgnoreCase
        )
        if (-not $record.processNameMatch) {
            $record.reason = 'The exact PID no longer identifies Siemens.Automation.Portal.'
            return [pscustomobject]$record
        }

        $observedStartUtcTicks = $process.StartTime.ToUniversalTime().Ticks
        $record.processStartTimeMatch = (
            $observedStartUtcTicks -eq $script:expectedProcessStartUtcTicks
        )
        if (-not $record.processStartTimeMatch) {
            $record.reason = 'The exact PID process-start identity changed; PID reuse or a restarted Portal session is refused.'
            return [pscustomobject]$record
        }
        if (Test-Deadline) {
            $record.status = 'partial'
            $record.reason = 'The strict navigation deadline expired during exact process identity validation.'
            return [pscustomobject]$record
        }

        Initialize-OfficialApi
        $officialProcesses = @([Siemens.Engineering.TiaPortal]::GetProcesses())
        $exactOfficialProcesses = @(
            $officialProcesses | Where-Object { [int]$_.Id -eq $ProcessId }
        )
        $record.officialProcessMatchCount = $exactOfficialProcesses.Count
        if ($exactOfficialProcesses.Count -ne 1) {
            $record.reason = 'The V20 Openness diagnostics surface did not expose exactly one session for the expected PID.'
            return [pscustomobject]$record
        }

        $officialProjectPath = $exactOfficialProcesses[0].ProjectPath
        if ($null -eq $officialProjectPath) {
            $record.reason = 'The exact official Portal session did not expose a project path.'
            return [pscustomobject]$record
        }
        $officialProjectPathText = if ($officialProjectPath -is [System.IO.FileInfo]) {
            $officialProjectPath.FullName
        } else {
            [string]$officialProjectPath
        }
        $canonicalOfficialProjectPath = Resolve-CanonicalProjectPath -Path $officialProjectPathText
        $record.projectPathMatch = [string]::Equals(
            $canonicalOfficialProjectPath,
            $script:canonicalExpectedProjectPath,
            [System.StringComparison]::OrdinalIgnoreCase
        )
        if (-not $record.projectPathMatch) {
            $record.reason = 'The exact PID now exposes a different canonical .ap20 project; UI interaction is refused.'
            return [pscustomobject]$record
        }
        if (Test-Deadline) {
            $record.status = 'partial'
            $record.reason = 'The strict navigation deadline expired during official project identity validation.'
            return [pscustomobject]$record
        }

        $record.ok = $true
        $record.status = 'verified'
        $record.reason = 'Exact PID, process start, and canonical .ap20 project path match the official V20 diagnostics surface.'
        return [pscustomobject]$record
    }
    catch {
        $record.status = 'session_mismatch'
        $record.reason = 'Exact Portal session validation failed closed: ' + $_.Exception.Message
        return [pscustomobject]$record
    }
    finally {
        $script:sessionVerificationRecords += [pscustomobject]$record
    }
}

function Write-Result {
    param([hashtable]$Value)

    $officialOpenAsserted = (
        $OfficialNavigationStatus -ceq 'opened_object'
    )
    if (-not $Value.ContainsKey('ok')) {
        $Value.ok = $false
    }
    if (-not $Value.ContainsKey('status')) {
        $Value.status = 'error'
    }
    if (-not $Value.ContainsKey('reason')) {
        $Value.reason = ''
    }
    if (-not $Value.ContainsKey('matches')) {
        $Value.matches = @()
    }
    if (-not $Value.ContainsKey('actions')) {
        $Value.actions = @()
    }
    if (-not $Value.ContainsKey('navigation')) {
        $Value.navigation = [ordered]@{
            openedObject = $officialOpenAsserted
            locatedNetwork = $false
            locationApplied = $false
        }
    }

    $Value.schemaVersion = '1.1'
    $Value.observedAtUtc = [DateTime]::UtcNow.ToString('o')
    $Value.processId = $ProcessId
    $Value.exactLabel = $ExactLabel
    $Value.officialNavigation = [ordered]@{
        status = $OfficialNavigationStatus
        callerAssertionAccepted = $officialOpenAsserted
        callerAssertion = $(if ($officialOpenAsserted) {
            'The trusted wrapper reports that the allowlisted official ShowInEditor step succeeded for this PID before launching the fallback.'
        } else {
            'The required exact opened_object assertion was not supplied; no successful official navigation is claimed.'
        })
        independentlyVerifiedByThisScript = $false
        confirmationTokenAccepted = ($ConfirmNavigation -ceq 'NAVIGATE_ACCESSIBLE_NETWORK')
    }
    $Value.exactSessionIdentity = [ordered]@{
        processId = $ProcessId
        expectedProcessStartTimeUtc = $ExpectedProcessStartTimeUtc
        canonicalExpectedProjectPath = $script:canonicalExpectedProjectPath
        officialApiVersion = $script:officialApiVersion
        verificationChecks = @($script:sessionVerificationRecords)
    }
    $fallbackAllowed = $true
    if ($Value.ContainsKey('fallbackAllowed')) {
        $fallbackAllowed = [bool]$Value.fallbackAllowed
    }
    $Value.uiAutomationFallback = [ordered]@{
        requested = $true
        allowed = $fallbackAllowed
        attempted = [bool]$Value.interactionAttempted
        status = [string]$Value.status
    }
    $Value.bounds = [ordered]@{
        timeoutMs = $TimeoutMs
        elapsedMs = $operationStopwatch.ElapsedMilliseconds
        maxNodes = $MaxNodes
        nodesVisited = $script:nodesVisited
        maxDepth = $MaxDepth
        maxAttempts = $MaxAttempts
        attemptsCompleted = $script:attemptsCompleted
        deadlineReached = $script:deadlineReached
        nodeLimitReached = $script:limitReached
        depthLimitReached = $script:depthLimitReached
        enumerationIncomplete = $script:enumerationIncomplete
        searchStarted = $script:searchStarted
        searchCompleted = $script:searchCompleted
        timeoutModel = 'cooperative_inner_deadline_with_required_host_process_timeout'
        synchronousProviderCallCanExceedInnerDeadline = $true
    }
    $Value.guarantees = [ordered]@{
        exactProcessIdOnly = $true
        exactProcessStartTimeRequired = $true
        exactCanonicalProjectPathRequired = $true
        officialGetProcessesIdentityCheck = $true
        exactOrdinalLabelOnly = $true
        uniqueMatchRequired = $true
        completeEnumerationRequired = $true
        coordinateInputUsed = $false
        screenshotOrVideoUsed = $false
        fuzzyMatchingUsed = $false
        invokePatternUsed = $false
        projectContentModified = $false
        projectSavedOrCompiled = $false
        plcAccessed = $false
        onlineOperationUsed = $false
    }
    $Value.Remove('interactionAttempted')
    $Value.Remove('fallbackAllowed')
    $Value | ConvertTo-Json -Depth 10 -Compress
}

try {
    if (
        $OfficialNavigationStatus -cne 'opened_object' -or
        $ConfirmNavigation -cne 'NAVIGATE_ACCESSIBLE_NETWORK'
    ) {
        Write-Result @{
            ok = $false
            status = 'confirmation_required'
            reason = 'The accessibility fallback requires the exact official-open assertion and the exact case-sensitive navigation confirmation token.'
            fallbackAllowed = $false
            interactionAttempted = $false
        }
        exit 0
    }
    if ([string]::IsNullOrWhiteSpace($ExactLabel) -or $ExactLabel -cne $ExactLabel.Trim()) {
        Write-Result @{
            ok = $false
            status = 'invalid_request'
            reason = 'ExactLabel must be non-empty and must not contain leading or trailing whitespace.'
            interactionAttempted = $false
        }
        exit 0
    }
    if ($ExactLabel.IndexOfAny([char[]]"`r`n`t") -ge 0) {
        Write-Result @{
            ok = $false
            status = 'invalid_request'
            reason = 'ExactLabel must be a single accessible label without control characters.'
            interactionAttempted = $false
        }
        exit 0
    }

    try {
        $parsedExpectedStart = [DateTimeOffset]::MinValue
        $parsedExpectedStartOk = [DateTimeOffset]::TryParse(
            $ExpectedProcessStartTimeUtc,
            [System.Globalization.CultureInfo]::InvariantCulture,
            [System.Globalization.DateTimeStyles]::RoundtripKind,
            [ref]$parsedExpectedStart
        )
        if (-not $parsedExpectedStartOk -or $parsedExpectedStart.Offset -ne [TimeSpan]::Zero) {
            throw [System.ArgumentException]::new('ExpectedProcessStartTimeUtc must be a valid UTC timestamp.')
        }
        $expectedProcessStartUtcTicks = $parsedExpectedStart.UtcDateTime.Ticks
        $canonicalExpectedProjectPath = Resolve-CanonicalProjectPath -Path $ExpectedProjectPath
        $canonicalApiDll = [System.IO.Path]::GetFullPath($ApiDll)
        Initialize-OfficialApi
    }
    catch {
        Write-Result @{
            ok = $false
            status = 'invalid_request'
            reason = 'Exact session identity validation inputs are invalid or unavailable: ' + $_.Exception.Message
            interactionAttempted = $false
        }
        exit 0
    }

    $beforeEnumerationSession = Test-ExactPortalSession -Phase 'before_enumeration'
    if (-not $beforeEnumerationSession.ok) {
        Write-Result @{
            ok = $false
            status = [string]$beforeEnumerationSession.status
            reason = [string]$beforeEnumerationSession.reason
            interactionAttempted = $false
        }
        exit 0
    }
    if (Test-Deadline) {
        Write-Result @{
            ok = $false
            status = 'partial'
            reason = 'The official object was opened, but the bounded accessibility fallback timed out before enumeration.'
            interactionAttempted = $false
        }
        exit 0
    }

    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes

    if (-not ('TiaAccessibleNetworkNative' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class TiaAccessibleNetworkNative
{
    private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr state);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr state);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

    public static IntPtr[] GetUsableTopLevelWindows(int requestedProcessId)
    {
        var windows = new List<IntPtr>();
        EnumWindows(delegate(IntPtr hwnd, IntPtr ignored)
        {
            uint processId;
            GetWindowThreadProcessId(hwnd, out processId);
            if (processId == (uint)requestedProcessId &&
                IsWindowVisible(hwnd) &&
                !IsIconic(hwnd))
            {
                windows.Add(hwnd);
            }
            return true;
        }, IntPtr.Zero);
        return windows.ToArray();
    }
}
'@
    }

    $windowHandles = @([TiaAccessibleNetworkNative]::GetUsableTopLevelWindows($ProcessId))
    if ($windowHandles.Count -eq 0) {
        Write-Result @{
            ok = $false
            status = 'unsupported'
            reason = 'The official object was opened, but the exact TIA PID has no visible, non-minimized top-level window available to UI Automation.'
            interactionAttempted = $false
        }
        exit 0
    }

    $roots = @()
    foreach ($windowHandle in $windowHandles) {
        if (Test-Deadline) { break }
        try {
            $candidateRoot = [System.Windows.Automation.AutomationElement]::FromHandle($windowHandle)
            if ($null -ne $candidateRoot -and
                [int]$candidateRoot.Current.ProcessId -eq $ProcessId) {
                $roots += $candidateRoot
            }
        }
        catch [System.Windows.Automation.ElementNotAvailableException] {
            $enumerationIncomplete = $true
        }
    }
    if ($roots.Count -eq 0) {
        Write-Result @{
            ok = $false
            status = $(if ($deadlineReached) { 'partial' } else { 'unsupported' })
            reason = $(if ($deadlineReached) {
                'The official object was opened, but the accessibility deadline expired while obtaining the exact-PID window roots.'
            } else {
                'UI Automation could not obtain a root element owned by the exact TIA PID.'
            })
            interactionAttempted = $false
        }
        exit 0
    }

    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $safeActionControlTypes = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::Ordinal
    )
    @(
        [System.Windows.Automation.ControlType]::TabItem.ProgrammaticName
        [System.Windows.Automation.ControlType]::TreeItem.ProgrammaticName
        [System.Windows.Automation.ControlType]::ListItem.ProgrammaticName
        [System.Windows.Automation.ControlType]::DataItem.ProgrammaticName
        [System.Windows.Automation.ControlType]::Text.ProgrammaticName
        [System.Windows.Automation.ControlType]::Custom.ProgrammaticName
        [System.Windows.Automation.ControlType]::Pane.ProgrammaticName
        [System.Windows.Automation.ControlType]::Group.ProgrammaticName
        [System.Windows.Automation.ControlType]::HeaderItem.ProgrammaticName
    ) | ForEach-Object { [void]$safeActionControlTypes.Add($_) }
    $matches = @()
    $matchRecords = @()

    function Find-ExactAccessibleLabel {
        param(
            [System.Windows.Automation.AutomationElement]$Parent,
            [int]$Depth
        )

        if ($Depth -gt $MaxDepth) {
            $script:depthLimitReached = $true
            return
        }
        if (Test-Deadline) { return }
        if ($script:nodesVisited -ge $MaxNodes) {
            $script:limitReached = $true
            return
        }

        try {
            $child = $walker.GetFirstChild($Parent)
        }
        catch [System.Windows.Automation.ElementNotAvailableException] {
            $script:enumerationIncomplete = $true
            return
        }
        if ($null -ne $child -and ($Depth + 1) -gt $MaxDepth) {
            $script:depthLimitReached = $true
            return
        }

        while ($null -ne $child) {
            if ((Test-Deadline) -or $script:nodesVisited -ge $MaxNodes) {
                if ($script:nodesVisited -ge $MaxNodes) {
                    $script:limitReached = $true
                }
                return
            }

            $script:nodesVisited += 1
            try {
                $current = $child.Current
                $isExactLabel = [string]::Equals(
                    [string]$current.Name,
                    $ExactLabel,
                    [System.StringComparison]::Ordinal
                )
                if (
                    [int]$current.ProcessId -eq $ProcessId -and
                    $current.IsEnabled -and
                    -not $current.IsOffscreen -and
                    $isExactLabel
                ) {
                    $script:matches += $child
                    $script:matchRecords += [ordered]@{
                        name = [string]$current.Name
                        controlType = [string]$current.ControlType.ProgrammaticName
                        automationId = [string]$current.AutomationId
                        processId = [int]$current.ProcessId
                        isEnabled = [bool]$current.IsEnabled
                        isKeyboardFocusable = [bool]$current.IsKeyboardFocusable
                    }
                }
            }
            catch [System.Windows.Automation.ElementNotAvailableException] {
                $script:enumerationIncomplete = $true
            }

            Find-ExactAccessibleLabel -Parent $child -Depth ($Depth + 1)
            if ($script:deadlineReached -or $script:limitReached) {
                return
            }

            try {
                $child = $walker.GetNextSibling($child)
            }
            catch [System.Windows.Automation.ElementNotAvailableException] {
                $script:enumerationIncomplete = $true
                return
            }
        }
    }

    $searchStarted = $true
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        if (Test-Deadline) { break }
        $matches = @()
        $matchRecords = @()
        foreach ($root in $roots) {
            Find-ExactAccessibleLabel -Parent $root -Depth 0
            if (
                $deadlineReached -or
                $limitReached -or
                $depthLimitReached -or
                $enumerationIncomplete
            ) {
                break
            }
        }
        $attemptsCompleted = $attempt
        if (
            $matches.Count -ne 0 -or
            $limitReached -or
            $depthLimitReached -or
            $enumerationIncomplete -or
            $attempt -eq $MaxAttempts
        ) {
            break
        }

        $remainingMs = $TimeoutMs - [int]$operationStopwatch.ElapsedMilliseconds
        if ($remainingMs -le 0) {
            $deadlineReached = $true
            break
        }
        Start-Sleep -Milliseconds ([Math]::Min($AttemptDelayMs, $remainingMs))
    }
    $searchCompleted = -not (
        $deadlineReached -or
        $limitReached -or
        $depthLimitReached -or
        $enumerationIncomplete
    )

    if ($matches.Count -eq 0) {
        $reason = 'The official object was opened, but no visible, enabled UI Automation element exactly matched the requested network/section label.'
        if ($deadlineReached) {
            $reason = 'The official object was opened, but the bounded exact-label search reached its deadline without locating the requested network/section.'
        }
        elseif ($limitReached) {
            $reason = 'The official object was opened, but the bounded exact-label search reached its node limit without locating the requested network/section.'
        }
        elseif ($depthLimitReached) {
            $reason = 'The official object was opened, but the bounded exact-label search reached its depth limit without proving the requested network/section was absent.'
        }
        elseif ($enumerationIncomplete) {
            $reason = 'The official object was opened, but the UI Automation tree changed or became unavailable before the exact-label search completed.'
        }
        Write-Result @{
            ok = $false
            status = 'partial'
            reason = $reason
            interactionAttempted = $false
        }
        exit 0
    }

    if ($matches.Count -gt 1) {
        Write-Result @{
            ok = $false
            status = 'ambiguous'
            reason = 'Multiple visible, enabled elements in the exact TIA PID matched the label ordinally; no action was taken.'
            matchCount = $matches.Count
            matches = @($matchRecords)
            interactionAttempted = $false
        }
        exit 0
    }

    if (
        $deadlineReached -or
        $limitReached -or
        $depthLimitReached -or
        $enumerationIncomplete
    ) {
        Write-Result @{
            ok = $false
            status = 'partial'
            reason = 'One exact label was observed, but the bounded accessibility enumeration did not complete, so uniqueness was not proven and no action was taken.'
            matchCount = 1
            matches = @($matchRecords)
            interactionAttempted = $false
        }
        exit 0
    }

    $target = $matches[0]
    $targetRecord = $matchRecords[0]
    $controlTypeActionAllowed = $safeActionControlTypes.Contains(
        [string]$targetRecord.controlType
    )
    $actions = @()
    $interactionAttempted = $false
    $selectionVerified = $false
    $focusVerified = $false
    $sessionStableAfterInteraction = $false

    $beforeInteractionSession = Test-ExactPortalSession -Phase 'before_interaction'
    if (-not $beforeInteractionSession.ok) {
        Write-Result @{
            ok = $false
            status = [string]$beforeInteractionSession.status
            reason = [string]$beforeInteractionSession.reason
            matchCount = 1
            matches = @($targetRecord)
            interactionAttempted = $false
        }
        exit 0
    }

    if ($controlTypeActionAllowed -and -not (Test-Deadline)) {
        $pattern = $null
        if ($target.TryGetCurrentPattern(
            [System.Windows.Automation.ScrollItemPattern]::Pattern,
            [ref]$pattern
        )) {
            $interactionWasAttempted = $true
            ([System.Windows.Automation.ScrollItemPattern]$pattern).ScrollIntoView()
            $actions += 'ScrollItem.ScrollIntoView'
            $actionsTaken += 'ScrollItem.ScrollIntoView'
            $interactionAttempted = $true
        }
    }

    if ($controlTypeActionAllowed -and -not (Test-Deadline)) {
        $pattern = $null
        if ($target.TryGetCurrentPattern(
            [System.Windows.Automation.SelectionItemPattern]::Pattern,
            [ref]$pattern
        )) {
            $selectionPattern = [System.Windows.Automation.SelectionItemPattern]$pattern
            $interactionWasAttempted = $true
            $selectionPattern.Select()
            $actions += 'SelectionItem.Select'
            $actionsTaken += 'SelectionItem.Select'
            $interactionAttempted = $true
            $selectionVerified = [bool]$selectionPattern.Current.IsSelected
        }
        else {
            try {
                if ($target.Current.IsKeyboardFocusable) {
                    $interactionWasAttempted = $true
                    $target.SetFocus()
                    $actions += 'AutomationElement.SetFocus'
                    $actionsTaken += 'AutomationElement.SetFocus'
                    $interactionAttempted = $true
                    $focusVerified = [bool]$target.Current.HasKeyboardFocus
                }
            }
            catch [System.Windows.Automation.ElementNotAvailableException] {
            }
        }
    }

    if ($interactionAttempted -and -not (Test-Deadline)) {
        $remainingMs = $TimeoutMs - [int]$operationStopwatch.ElapsedMilliseconds
        if ($remainingMs -gt 0) {
            Start-Sleep -Milliseconds ([Math]::Min(75, $remainingMs))
        }
    }

    if ($interactionAttempted) {
        $afterInteractionSession = Test-ExactPortalSession -Phase 'after_interaction'
        $sessionStableAfterInteraction = [bool]$afterInteractionSession.ok
    }

    $stillExact = $false
    $isVisible = $false
    $sameProcess = $false
    if (-not (Test-Deadline)) {
        try {
            $stillExact = [string]::Equals(
                [string]$target.Current.Name,
                $ExactLabel,
                [System.StringComparison]::Ordinal
            )
            $isVisible = -not [bool]$target.Current.IsOffscreen
            $sameProcess = [int]$target.Current.ProcessId -eq $ProcessId

            $pattern = $null
            if ($target.TryGetCurrentPattern(
                [System.Windows.Automation.SelectionItemPattern]::Pattern,
                [ref]$pattern
            )) {
                $selectionVerified = [bool](
                    [System.Windows.Automation.SelectionItemPattern]$pattern
                ).Current.IsSelected
            }
            $focusVerified = [bool]$target.Current.HasKeyboardFocus
        }
        catch [System.Windows.Automation.ElementNotAvailableException] {
            $stillExact = $false
            $isVisible = $false
            $sameProcess = $false
        }
    }

    [void](Test-Deadline)
    $verified = (
        -not $deadlineReached -and
        $sessionStableAfterInteraction -and
        $sameProcess -and
        $stillExact -and
        $isVisible -and
        $selectionVerified
    )

    Write-Result @{
        ok = $verified
        status = $(if ($verified) { 'located_network' } else { 'partial' })
        reason = $(if ($verified) {
            'The unique exact accessible label is visible and selected, and exact PID/start/project identity remained verified through the action.'
        } elseif ($interactionAttempted -and -not $sessionStableAfterInteraction) {
            'A bounded UI-only action was attempted, but the exact PID/start/project identity could not be revalidated afterward; success is refused.'
        } elseif ($deadlineReached) {
            'The exact label was found, but the strict deadline expired before selection or focus could be verified.'
        } elseif ($focusVerified) {
            'The unique exact label has keyboard focus, but focus alone does not prove that TIA selected or navigated to the requested network/section.'
        } elseif (-not $controlTypeActionAllowed) {
            'The exact label was found, but its UI Automation control type is not allowlisted for network/section selection or focus; no action was taken.'
        } elseif (-not $interactionAttempted) {
            'The exact label was found, but it exposed neither a safe SelectionItem pattern nor a keyboard-focusable target; no action was taken.'
        } else {
            'The exact label was found and a bounded UI-only action was attempted, but visible selection or focus could not be verified.'
        })
        matchCount = 1
        matches = @($targetRecord)
        actions = $actions
        selected = $selectionVerified
        hasKeyboardFocus = $focusVerified
        isVisible = $isVisible
        controlTypeActionAllowed = $controlTypeActionAllowed
        interactionAttempted = $interactionAttempted
        navigation = [ordered]@{
            openedObject = $true
            locatedNetwork = $verified
            locationApplied = $verified
        }
    }
}
catch {
    Write-Result @{
        ok = $false
        status = 'error'
        reason = $_.Exception.Message
        actions = $actionsTaken
        interactionAttempted = $interactionWasAttempted
    }
    exit 0
}
