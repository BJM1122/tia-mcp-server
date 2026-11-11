using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using Siemens.Engineering;
using Siemens.Engineering.Compiler;
using Siemens.Engineering.HW;
using Siemens.Engineering.HW.Features;
using Siemens.Engineering.HmiUnified;
using Siemens.Engineering.HmiUnified.UI.Screens;
using Siemens.Engineering.HmiUnified.UI.Widgets;
using Siemens.Engineering.HmiUnified.UI.Shapes;
using Siemens.Engineering.HmiUnified.UI.Controls;
using Siemens.Engineering.HmiUnified.UI.Dynamization;
using Siemens.Engineering.HmiUnified.UI.Enum;
using Siemens.Engineering.HmiUnified.UI.Parts;
using Siemens.Engineering.HmiUnified.RuntimeSettings.HmiRuntimeSettingsCommon;

internal static partial class TiaHmiNative
{
    // Defer JIT type resolution until Main installs the Siemens assembly resolver.
    [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
    static void UnifiedOfflineCheck() {
        Expect(UnifiedColor("#123456",true).A,0,"offline transparent color");
        Expect(UnifiedResolution(new Dictionary<string,object>{{"device",new Dictionary<string,object>{{"width",800},{"height",480}}}}).ToString(),"SR_800X480","offline resolution");
    }
    static Dictionary<string,object> D(object value) { return (Dictionary<string,object>)value; }
    static IEnumerable<Dictionary<string,object>> Rows(Dictionary<string,object> value, string key) { return ((IEnumerable)value[key]).Cast<object>().Select(D); }
    static void UnifiedItems(DeviceItem item, string path, List<Tuple<HmiSoftware,string>> found) {
        var container = item.GetService<SoftwareContainer>();
        if (container != null && container.Software is HmiSoftware) found.Add(Tuple.Create((HmiSoftware)container.Software,path));
        foreach (DeviceItem child in item.DeviceItems) UnifiedItems(child,path + "/" + child.Name,found);
    }
    static void UnifiedDevices(IEnumerable<Device> devices, string path, List<Tuple<HmiSoftware,string>> found) {
        foreach (Device device in devices) foreach (DeviceItem item in device.DeviceItems) UnifiedItems(item,path+device.Name+"/"+item.Name,found);
    }
    static void UnifiedGroups(DeviceUserGroup group, string path, List<Tuple<HmiSoftware,string>> found) {
        string next=path+group.Name+"/"; UnifiedDevices(group.Devices,next,found);
        foreach(DeviceUserGroup child in group.Groups) UnifiedGroups(child,next,found);
    }
    static List<Tuple<HmiSoftware,string>> UnifiedTargets(Project project) {
        var targets=new List<Tuple<HmiSoftware,string>>(); UnifiedDevices(project.Devices,"",targets);
        foreach(DeviceUserGroup group in project.DeviceGroups) UnifiedGroups(group,"",targets);
        return targets;
    }
    static HmiSoftware SingleUnifiedTarget(Project project) {
        var targets=UnifiedTargets(project);
        if(targets.Count!=1) throw new Exception("Catalog item must create exactly one Unified HMI software target.");
        return targets[0].Item1;
    }
    static Color UnifiedColor(string hex, bool transparent) { return Color.FromArgb(transparent?0:255,ColorTranslator.FromHtml(hex)); }
    static void Put(object item,string name,object value) {
        var property=item.GetType().GetProperty(name);
        if(property==null || !property.CanWrite) throw new Exception("Unsupported public Unified property: "+name);
        property.SetValue(item,Convert.ChangeType(value,property.PropertyType,CultureInfo.InvariantCulture),null);
    }
    static void Expect(object actual,object expected,string path) {
        if(actual is Color && expected is Color) { if(((Color)actual).ToArgb()==((Color)expected).ToArgb()) return; }
        else if(Convert.ToString(actual,CultureInfo.InvariantCulture)==Convert.ToString(expected,CultureInfo.InvariantCulture)) return;
        throw new Exception("Unified requested-value readback mismatch: "+path);
    }
    static Language UnifiedLanguage(Project project,string culture,bool activate) {
        var language=project.LanguageSettings.Languages.Find(CultureInfo.GetCultureInfo(culture));
        if(language==null) throw new Exception("Requested project language unavailable: "+culture);
        if(activate && !project.LanguageSettings.ActiveLanguages.Contains(language)) project.LanguageSettings.ActiveLanguages.Add(language);
        return language;
    }
    static ScreenResolution UnifiedResolution(Dictionary<string,object> program) {
        var device=D(program["device"]);
        string value="SR_"+S(device,"width")+"X"+S(device,"height");
        return (ScreenResolution)Enum.Parse(typeof(ScreenResolution),value,true);
    }
    static object UnifiedInitialValue(Dictionary<string,object> tag) {
        object value=tag["initialValue"];
        switch(S(tag,"dataType")) {
            case "Bool": return Convert.ToBoolean(value);
            case "Int": return Convert.ToInt16(value);
            case "DInt": return Convert.ToInt32(value);
            case "UInt": case "Word": return Convert.ToUInt16(value);
            case "UDInt": case "DWord": return Convert.ToUInt32(value);
            case "Real": return Convert.ToSingle(value);
            case "WString": return Convert.ToString(value);
            default: throw new Exception("Unsupported initial value datatype.");
        }
    }
    static void FillUnified(Project project,HmiSoftware target,Dictionary<string,object> program) {
        Language language=UnifiedLanguage(project,S(program,"language"),true);
        var runtimeLanguage=target.RuntimeSettings.LanguageAndFonts.Single(l=>String.Equals(l.Language,S(program,"language"),StringComparison.OrdinalIgnoreCase));
        foreach(var entry in target.RuntimeSettings.LanguageAndFonts) entry.Enable=entry==runtimeLanguage;
        foreach(var input in Rows(program,"internalTags")) {
            string name=S(input,"name");
            if(target.Tags.Find(name)!=null) throw new Exception("Generated tag collides with an existing default: "+name);
            var tag=target.Tags.Create(name); tag.DataType=S(input,"dataType");
            if(input.ContainsKey("initialValue")) tag.InitialValue=UnifiedInitialValue(input);
        }
        CreateUnifiedResources(target,program,language);
        foreach(var input in Rows(program,"screens")) {
            if(target.Screens.Find(S(input,"name"))!=null) throw new Exception("Generated screen collides with an existing default.");
            var screen=target.Screens.Create(S(input,"name"));
            screen.ScreenNumber=Convert.ToUInt16(input["number"]);
            screen.Width=Convert.ToUInt32(D(program["device"])["width"]); screen.Height=Convert.ToUInt32(D(program["device"])["height"]);
            screen.BackColor=UnifiedColor(S(input,"background"),false);
        }
        foreach(var input in Rows(program,"screens")) {
            var screen=target.Screens.Find(S(input,"name"));
            foreach(var e in Rows(input,"elements")) {
                object item;
                switch(S(e,"type")) {
                    case "text": item=screen.ScreenItems.Create<HmiTextBox>(S(e,"name")); break;
                    case "button": item=screen.ScreenItems.Create<HmiButton>(S(e,"name")); break;
                    case "rectangle": item=screen.ScreenItems.Create<HmiRectangle>(S(e,"name")); break;
                    case "ioField": item=screen.ScreenItems.Create<HmiIOField>(S(e,"name")); break;
                    case "alarmView": item=screen.ScreenItems.Create<HmiAlarmControl>(S(e,"name")); break;
                    case "trendView": item=screen.ScreenItems.Create<HmiTrendControl>(S(e,"name")); break;
                    default: throw new Exception("Unsupported Unified control.");
                }
                Put(item,"Left",e["x"]); Put(item,"Top",e["y"]); Put(item,"Width",e["width"]); Put(item,"Height",e["height"]);
                item.GetType().GetProperty("BackColor").SetValue(item,UnifiedColor(S(e,"background"),Convert.ToBoolean(e["transparent"])),null);
                Put(item,"Visible",true); Put(item,"Enabled",true);
                if(item is HmiTextBox || item is HmiButton || item is HmiIOField) {
                    item.GetType().GetProperty("ForeColor").SetValue(item,UnifiedColor(S(e,"foreground"),false),null);
                    var font=(HmiFontPart)Property(item,"Font"); font.Size=Convert.ToSingle(e["fontSize"]); font.Name=S(program,"language")=="zh-CN"?HmiFontName.SimSun:HmiFontName.Arial;
                    if(!(item is HmiIOField)) ((MultilingualText)Property(item,"Text")).Items.Find(language).Text=S(e,"text");
                }
                var button=item as HmiButton;
                if(button!=null) {
                    button.Content.ContentMode=HmiContentMode.Text;
                    foreach(var evt in Rows(e,"events")) {
                        var handler=button.EventHandlers.Create((HmiButtonEventType)Enum.Parse(typeof(HmiButtonEventType),S(evt,"event")));
                        handler.Script.Async=false; handler.Script.ScriptCode=S(evt,"code");
                    }
                }
                var io=item as HmiIOField;
                if(io!=null) {
                    io.IOFieldType=(HmiIOFieldType)Enum.Parse(typeof(HmiIOFieldType),S(e,"ioMode"));
                    var binding=io.Dynamizations.Create<TagDynamization>("ProcessValue");
                    binding.Tag=S(e,"valueTag"); binding.ReadOnly=S(e,"ioMode")=="Output"; binding.UseIndirectAddressing=false;
                }
                var alarmView=item as HmiAlarmControl;
                if(alarmView!=null) {
                    alarmView.AlarmSourceType=(HmiAlarmSourceType)Enum.Parse(typeof(HmiAlarmSourceType),S(e,"alarmSource"));
                    alarmView.Filter=S(e,"alarmFilter");alarmView.UseAlarmColors=true;
                    alarmView.ActiveAlarmsViewSetup=HmiVisibleAlarms.UnSuppressed;
                    alarmView.AlarmDefinitionViewSetup=HmiVisibleAlarms.UnSuppressed;
                }
                var trendView=item as HmiTrendControl;
                if(trendView!=null) ConfigureUnifiedTrend(trendView,e,language,false);
            }
            if(!String.IsNullOrEmpty(S(input,"unloadScript"))) {
                var handler=screen.EventHandlers.Create(HmiScreenEventType.Unloaded);
                handler.Script.Async=false; handler.Script.ScriptCode=S(input,"unloadScript");
            }
        }
        target.RuntimeSettings.StartScreen=S(program,"startScreen");
        target.RuntimeSettings.ScreenResolution=UnifiedResolution(program);
    }
    static void VerifyUnified(Project project,HmiSoftware target,Dictionary<string,object> program) {
        var language=UnifiedLanguage(project,S(program,"language"),false);
        Expect(target.RuntimeSettings.LanguageAndFonts.Single(l=>l.Enable).Language.ToLowerInvariant(),S(program,"language").ToLowerInvariant(),"RuntimeLanguage");
        Expect(target.RuntimeSettings.StartScreen,S(program,"startScreen"),"StartScreen");
        Expect(target.RuntimeSettings.ScreenResolution,UnifiedResolution(program),"ScreenResolution");
        VerifyUnifiedResources(target,program,language);
        foreach(var input in Rows(program,"internalTags")) {
            var tag=target.Tags.Find(S(input,"name")); if(tag==null) throw new Exception("Unified tag missing.");
            Expect(tag.DataType,S(input,"dataType"),"Tag.DataType");
            if(input.ContainsKey("initialValue")) Expect(tag.InitialValue,UnifiedInitialValue(input),"Tag.InitialValue");
        }
        foreach(var input in Rows(program,"screens")) {
            var screen=target.Screens.Find(S(input,"name")); if(screen==null) throw new Exception("Unified screen missing.");
            Expect(screen.ScreenNumber,input["number"],"ScreenNumber");
            Expect(screen.Width,D(program["device"])["width"],"Screen.Width"); Expect(screen.Height,D(program["device"])["height"],"Screen.Height");
            Expect(screen.BackColor,UnifiedColor(S(input,"background"),false),"Screen.BackColor");
            foreach(var e in Rows(input,"elements")) {
                var item=screen.ScreenItems.Find(S(e,"name")); if(item==null) throw new Exception("Unified control missing.");
                var types=new Dictionary<string,Type>{{"text",typeof(HmiTextBox)},{"button",typeof(HmiButton)},{"rectangle",typeof(HmiRectangle)},{"ioField",typeof(HmiIOField)},{"alarmView",typeof(HmiAlarmControl)},{"trendView",typeof(HmiTrendControl)}};
                if(!types[S(e,"type")].IsInstanceOfType(item)) throw new Exception("Unified control type mismatch.");
                Expect(Property(item,"Left"),e["x"],"Left"); Expect(Property(item,"Top"),e["y"],"Top");
                Expect(Property(item,"Width"),e["width"],"Width"); Expect(Property(item,"Height"),e["height"],"Height");
                Expect(Property(item,"BackColor"),UnifiedColor(S(e,"background"),Convert.ToBoolean(e["transparent"])),"BackColor");
                Expect(item.Enabled,true,"Enabled"); Expect(item.Visible,true,"Visible");
                if(item is HmiTextBox || item is HmiButton || item is HmiIOField) {
                    Expect(Property(item,"ForeColor"),UnifiedColor(S(e,"foreground"),false),"ForeColor");
                    var font=(HmiFontPart)Property(item,"Font"); Expect(font.Size,e["fontSize"],"Font.Size");
                    Expect(font.Name,S(program,"language")=="zh-CN"?HmiFontName.SimSun:HmiFontName.Arial,"Font.Name");
                    if(!(item is HmiIOField)) Expect(((MultilingualText)Property(item,"Text")).Items.Find(language).Text,S(e,"text"),"Text");
                }
                var button=item as HmiButton;
                if(button!=null) { Expect(button.Content.ContentMode,HmiContentMode.Text,"Button.ContentMode"); foreach(var evt in Rows(e,"events")) {
                    var handler=button.EventHandlers.Find((HmiButtonEventType)Enum.Parse(typeof(HmiButtonEventType),S(evt,"event")));
                    if(handler==null) throw new Exception("Unified button event missing.");
                    Expect(handler.Script.ScriptCode,S(evt,"code"),"Event.ScriptCode"); Expect(handler.Script.Async,false,"Event.Async");
                } }
                var io=item as HmiIOField;
                if(io!=null) {
                    Expect(io.IOFieldType,S(e,"ioMode"),"IOFieldType");
                    var binding=io.Dynamizations.OfType<TagDynamization>().Single(d=>d.PropertyName=="ProcessValue");
                    Expect(binding.Tag,S(e,"valueTag"),"Binding.Tag"); Expect(binding.ReadOnly,S(e,"ioMode")=="Output","Binding.ReadOnly"); Expect(binding.UseIndirectAddressing,false,"Binding.Indirect");
                }
                var alarmView=item as HmiAlarmControl;
                if(alarmView!=null) {
                    Expect(alarmView.AlarmSourceType,S(e,"alarmSource"),"AlarmView.Source");Expect(alarmView.Filter,S(e,"alarmFilter"),"AlarmView.Filter");
                    Expect(alarmView.UseAlarmColors,true,"AlarmView.UseColors");Expect(alarmView.ActiveAlarmsViewSetup,HmiVisibleAlarms.UnSuppressed,"AlarmView.ActiveSetup");Expect(alarmView.AlarmDefinitionViewSetup,HmiVisibleAlarms.UnSuppressed,"AlarmView.DefinitionSetup");
                }
                var trendView=item as HmiTrendControl;
                if(trendView!=null) ConfigureUnifiedTrend(trendView,e,language,true);
            }
            if(!String.IsNullOrEmpty(S(input,"unloadScript"))) Expect(screen.EventHandlers.Find(HmiScreenEventType.Unloaded).Script.ScriptCode,S(input,"unloadScript"),"Unloaded.ScriptCode");
        }
    }
    static void CreateUnifiedProject(Dictionary<string,object> request) {
        string parent=Path.GetFullPath(S(request,"outputParent")),name=S(request,"projectName");
        if(!Directory.Exists(parent)||String.IsNullOrWhiteSpace(name)||name!=Path.GetFileName(name)||name=="."||name==".."||name.IndexOfAny(Path.GetInvalidFileNameChars())>=0) throw new Exception("Invalid Unified destination.");
        string destination=Path.Combine(parent,name),lockPath=Path.Combine(parent,"."+name+".hmi-build.lock");
        if(Directory.Exists(destination)||File.Exists(destination)) throw new Exception("Unified destination exists; overwrite prohibited.");
        var program=D(request["program"]);
        if(S(program,"adapter")!="wincc-unified-v20") throw new Exception("Unified adapter mismatch.");
        UnifiedResolution(program); // Reject an unsupported resolution before creating anything.
        using(var buildLock=new FileStream(lockPath,FileMode.CreateNew,FileAccess.Write,FileShare.None)) {
            string stage="start",projectPath=null,evidence=null;
            try {
                if(Directory.Exists(destination)||File.Exists(destination)) throw new Exception("Destination appeared after planning.");
                using(var portal=new TiaPortal(TiaPortalMode.WithoutUserInterface)) {
                    stage="create_project"; mutationAttempted=true;
                    var project=portal.Projects.Create(new DirectoryInfo(parent),name); projectPath=project.Path.FullName;
                    evidence=Path.Combine(destination,"hmi-authoring-evidence"); Directory.CreateDirectory(evidence);
                    File.WriteAllText(Path.Combine(evidence,"unified-program.json"),Json.Serialize(program),new UTF8Encoding(false));
                    stage="create_device"; var device=project.Devices.CreateWithItem(S(request,"typeIdentifier"),S(request,"deviceName"),S(request,"deviceName"));
                    var target=SingleUnifiedTarget(project);
                    stage="create_objects"; FillUnified(project,target,program);
                    stage="compile"; var compiler=device.GetService<ICompilable>();
                    if(compiler==null) throw new Exception("Unified compiler unavailable.");
                    var result=compiler.Compile(); var messages=new List<object>(); Messages(result.Messages,messages,0);
                    File.WriteAllText(Path.Combine(evidence,"compile.json"),Json.Serialize(new{state=result.State.ToString(),errors=result.ErrorCount,warnings=result.WarningCount,messages=messages}),new UTF8Encoding(false));
                    if(result.ErrorCount!=0||result.State==CompilerResultState.Error) throw new Exception("Unified compilation failed; inspect compile.json.");
                    stage="verify_before_save"; VerifyUnified(project,target,program);
                    stage="save"; project.Save(); project.Close();
                }
                stage="independent_reopen";
                using(var portal=new TiaPortal(TiaPortalMode.WithoutUserInterface)) {
                    var project=portal.Projects.Open(new FileInfo(projectPath)); VerifyUnified(project,SingleUnifiedTarget(project),program); project.Close();
                }
                File.WriteAllText(Path.Combine(evidence,"verification.json"),Json.Serialize(new{verified=true,mode="independent_project_reopen_requested_values",programSha256=S(request,"programSha256")}),new UTF8Encoding(false));
                Console.WriteLine(Json.Serialize(new{ok=true,status="created_and_reopened",adapter="wincc-unified-v20",projectPath=projectPath,saved=true,evidenceDirectory=evidence,
                    verificationMode="independent_project_reopen_requested_values",nativeDefaultsAllowed=true,runtimeTested=false,downloaded=false}));
            } catch(Exception ex) {
                Console.WriteLine(Json.Serialize(new{ok=false,status="unified_project_creation_failed",stage=stage,error=ex.GetBaseException().Message,projectPath=projectPath,outputDirectory=destination,
                    evidenceDirectory=evidence,partialOutputRetained=Directory.Exists(destination),downloaded=false}));
            }
        }
        try {File.Delete(lockPath);} catch(Exception) {Console.Error.WriteLine("Unified build lock cleanup failed.");}
    }
    static void ConfigureUnifiedTrend(HmiTrendControl control,Dictionary<string,object> input,Language language,bool verify) {
        var series=Rows(input,"trendSeries").ToArray();
        if(control.TrendAreas.Count>1)throw new Exception("Unexpected native default trend areas; no defaults are silently discarded.");
        if(!verify && control.TrendAreas.Count==0)control.TrendAreas.Create("AI_TrendArea");
        var area=control.TrendAreas.Single();
        if(!verify) {
            if(area.BottomTimeAxes.Count==0)area.BottomTimeAxes.Create("AI_TimeAxis");
            if(area.LeftValueAxes.Count==0)area.LeftValueAxes.Create("AI_ValueAxis");
            if(area.Trends.Count>series.Length)throw new Exception("Unexpected extra native default trends.");
            while(area.Trends.Count<series.Length)area.Trends.Create();
        }
        var time=area.BottomTimeAxes.Single();var values=area.LeftValueAxes.Single();
        if(verify) {
            Expect(control.Online,true,"Trend.Online");Expect(area.Visible,true,"Trend.AreaVisible");Expect(area.Trends.Count,series.Length,"Trend.Count");
            Expect(time.RangeType,HmiTimeRangeType.TimeRange,"Trend.TimeRangeType");Expect(time.TimeRangeBase,HmiTimeRangeBase.Second,"Trend.TimeBase");
            Expect(time.TimeRangeFactor,input["trendWindowSeconds"],"Trend.WindowSeconds");Expect(time.AlwaysShowRecent,true,"Trend.Recent");Expect(time.Visible,true,"Trend.TimeAxisVisible");
            Expect(values.AutoRange,false,"Trend.AutoRange");Expect(values.AutoScaling,false,"Trend.AutoScaling");Expect(values.Visible,true,"Trend.ValueAxisVisible");
            Expect(values.BeginValue,input["trendMin"],"Trend.Minimum");Expect(values.EndValue,input["trendMax"],"Trend.Maximum");
        } else {
            control.Online=true;area.Visible=true;time.RangeType=HmiTimeRangeType.TimeRange;time.TimeRangeBase=HmiTimeRangeBase.Second;
            time.TimeRangeFactor=Convert.ToInt32(input["trendWindowSeconds"]);time.AlwaysShowRecent=true;time.Visible=true;
            values.AutoRange=false;values.AutoScaling=false;values.Visible=true;values.BeginValue=Convert.ToDouble(input["trendMin"]);values.EndValue=Convert.ToDouble(input["trendMax"]);
        }
        for(int i=0;i<series.Length;i++) {
            var trend=area.Trends[i];var row=series[i];
            if(verify) {
                Expect(trend.DataSourceY.Source,S(row,"tag"),"Trend.Source");Expect(trend.DisplayName.Items.Find(language).Text,S(row,"label"),"Trend.Label");
                Expect(trend.LineColor,UnifiedColor(S(row,"color"),false),"Trend.Color");Expect(trend.Visible,true,"Trend.Visible");Expect(trend.TrendMode,HmiTrendMode.Interpolated,"Trend.Mode");
            } else {
                trend.DataSourceY.Source=S(row,"tag");trend.DisplayName.Items.Find(language).Text=S(row,"label");
                trend.LineColor=UnifiedColor(S(row,"color"),false);trend.Visible=true;trend.TrendMode=HmiTrendMode.Interpolated;
            }
        }
    }
    static void CreateUnifiedResources(HmiSoftware target,Dictionary<string,object> program,Language language) {
        foreach(var input in Rows(program,"connections")) {
            string name=S(input,"name"); if(target.Connections.Find(name)!=null) throw new Exception("Connection collides with native default: "+name);
            var connection=target.Connections.Create(name); connection.CommunicationDriver=S(input,"communicationDriver");
            connection.InitialAddress=S(input,"initialAddress"); connection.DisabledAtStartup=Convert.ToBoolean(input["disabledAtStartup"]);
            foreach(var entry in Rows(input,"driverProperties")) {
                var property=connection.DriverProperties.Find(S(entry,"name"));
                if(property==null) throw new Exception("Exact driver property is unavailable: "+S(entry,"name"));
                property.Value=S(entry,"value");
            }
        }
        foreach(var input in Rows(program,"externalTags")) {
            string name=S(input,"name"); if(target.Tags.Find(name)!=null) throw new Exception("External tag collides with existing tag: "+name);
            var tag=target.Tags.Create(name);tag.DataType=S(input,"dataType");tag.Connection=S(input,"connection");
            tag.AccessMode=(Siemens.Engineering.HmiUnified.HmiTags.HmiAccessMode)Enum.Parse(typeof(Siemens.Engineering.HmiUnified.HmiTags.HmiAccessMode),S(input,"accessMode"));
            if(S(input,"accessMode")=="AbsoluteAccess")tag.Address=S(input,"address");else tag.PlcTag=S(input,"plcTag");
        }
        foreach(var input in Rows(program,"alarmClasses")) {
            string name=S(input,"name");if(target.AlarmClasses.Find(name)!=null)throw new Exception("Alarm class collides with a native default: "+name);
            var alarmClass=target.AlarmClasses.Create(name);alarmClass.Priority=Convert.ToByte(input["priority"]);
            alarmClass.StateMachine=(Siemens.Engineering.HmiUnified.HmiAlarm.HmiAlarmCommon.HmiAlarmStateMachine)Enum.Parse(typeof(Siemens.Engineering.HmiUnified.HmiAlarm.HmiAlarmCommon.HmiAlarmStateMachine),S(input,"stateMachine"));
        }
        foreach(var input in Rows(program,"discreteAlarms")) {
            string name=S(input,"name");if(target.DiscreteAlarms.Find(name)!=null)throw new Exception("Alarm collides with an existing object: "+name);
            var alarm=target.DiscreteAlarms.Create(name);alarm.Id=Convert.ToUInt32(input["id"]);alarm.AlarmClass=S(input,"alarmClass");alarm.Priority=Convert.ToByte(input["priority"]);
            alarm.RaisedStateTag=S(input,"triggerTag");alarm.RaisedStateTagBitNumber=Convert.ToUInt32(input["triggerBit"]);
            alarm.TriggerMode=(Siemens.Engineering.HmiUnified.HmiAlarm.HmiAlarmCommon.HmiDiscreteAlarmTriggerMode)Enum.Parse(typeof(Siemens.Engineering.HmiUnified.HmiAlarm.HmiAlarmCommon.HmiDiscreteAlarmTriggerMode),S(input,"triggerMode"));
            alarm.EventText.Items.Find(language).Text=S(input,"text");alarm.InfoText.Items.Find(language).Text=S(input,"infoText");
        }
    }
    static void VerifyUnifiedResources(HmiSoftware target,Dictionary<string,object> program,Language language) {
        foreach(var input in Rows(program,"connections")) {
            var connection=target.Connections.Find(S(input,"name"));if(connection==null)throw new Exception("Unified connection missing.");
            Expect(connection.CommunicationDriver,S(input,"communicationDriver"),"Connection.Driver");Expect(connection.InitialAddress,S(input,"initialAddress"),"Connection.InitialAddress");
            Expect(connection.DisabledAtStartup,input["disabledAtStartup"],"Connection.DisabledAtStartup");
            foreach(var entry in Rows(input,"driverProperties"))Expect(connection.DriverProperties.Find(S(entry,"name")).Value,S(entry,"value"),"Connection.DriverProperty");
        }
        foreach(var input in Rows(program,"externalTags")) {
            var tag=target.Tags.Find(S(input,"name"));if(tag==null)throw new Exception("Unified external tag missing.");
            Expect(tag.DataType,S(input,"dataType"),"ExternalTag.DataType");Expect(tag.Connection,S(input,"connection"),"ExternalTag.Connection");Expect(tag.AccessMode,S(input,"accessMode"),"ExternalTag.AccessMode");
            if(S(input,"accessMode")=="AbsoluteAccess")Expect(tag.Address,S(input,"address"),"ExternalTag.Address");else Expect(tag.PlcTag,S(input,"plcTag"),"ExternalTag.PlcTag");
        }
        foreach(var input in Rows(program,"alarmClasses")) {
            var alarmClass=target.AlarmClasses.Find(S(input,"name"));if(alarmClass==null)throw new Exception("Unified alarm class missing.");
            Expect(alarmClass.Priority,input["priority"],"AlarmClass.Priority");Expect(alarmClass.StateMachine,S(input,"stateMachine"),"AlarmClass.StateMachine");
        }
        foreach(var input in Rows(program,"discreteAlarms")) {
            var alarm=target.DiscreteAlarms.Find(S(input,"name"));if(alarm==null)throw new Exception("Unified discrete alarm missing.");
            Expect(alarm.Id,input["id"],"Alarm.Id");Expect(alarm.AlarmClass,S(input,"alarmClass"),"Alarm.Class");Expect(alarm.Priority,input["priority"],"Alarm.Priority");
            Expect(alarm.RaisedStateTag,S(input,"triggerTag"),"Alarm.Tag");Expect(alarm.RaisedStateTagBitNumber,input["triggerBit"],"Alarm.Bit");Expect(alarm.TriggerMode,S(input,"triggerMode"),"Alarm.TriggerMode");
            Expect(alarm.EventText.Items.Find(language).Text,S(input,"text"),"Alarm.Text");Expect(alarm.InfoText.Items.Find(language).Text,S(input,"infoText"),"Alarm.InfoText");
        }
    }
    static void UnifiedScreenGroups(Siemens.Engineering.HmiUnified.UI.ScreenGroup.HmiScreenGroup group,string path,List<Tuple<HmiScreen,string>> screens) {
        string next=path+group.Name+"/";
        foreach(var screen in group.Screens) screens.Add(Tuple.Create(screen,next+screen.Name));
        foreach(var child in group.Groups) UnifiedScreenGroups(child,next,screens);
    }
    static List<Tuple<HmiScreen,string>> UnifiedScreens(HmiSoftware target) {
        var screens=target.Screens.Select(s=>Tuple.Create(s,s.Name)).ToList();
        foreach(var group in target.ScreenGroups) UnifiedScreenGroups(group,"",screens);
        return screens;
    }
    static Dictionary<string,object> UnifiedObjectSnapshot(Project project,HmiScreen screen,object item,string culture) {
        if(!(item is HmiButton || item is HmiTextBox || item is HmiIOField || item is HmiRectangle)) throw new Exception("Scoped editing supports text, button, IO field and rectangle only.");
        var properties=new Dictionary<string,object>();
        foreach(string key in new[]{"Left","Top","Width","Height","BackColor","ForeColor"}) {
            var p=item.GetType().GetProperty(key); if(p==null) continue;
            object value=p.GetValue(item,null);
            properties[key]=value is Color ? (object)("#"+unchecked((uint)((Color)value).ToArgb()).ToString("X8")) : value;
        }
        if(item is HmiTextBox || item is HmiButton) properties["Text"]=((MultilingualText)Property(item,"Text")).Items.Find(UnifiedLanguage(project,culture,false)).Text;
        if(!(item is HmiRectangle)) properties["FontSize"]=((HmiFontPart)Property(item,"Font")).Size;
        var dynamicProperties=new List<string>(); var bindings=new List<object>();
        foreach(object d in (IEnumerable)Property(item,"Dynamizations")) {
            string property=Convert.ToString(Property(d,"PropertyName")); dynamicProperties.Add(property);
            var tag=d as TagDynamization;
            bindings.Add(new{property=property,type=d.GetType().FullName,tag=tag==null?null:tag.Tag,readOnly=tag==null?(bool?)null:tag.ReadOnly,indirect=tag==null?(bool?)null:tag.UseIndirectAddressing});
        }
        // Nested font dynamizations must also prevent static replacement of Size.
        if(!(item is HmiRectangle)) {
            object font=Property(item,"Font"); var composition=font.GetType().GetProperty("Dynamizations");
            if(composition!=null) foreach(object d in (IEnumerable)composition.GetValue(font,null)) dynamicProperties.Add("Font."+Convert.ToString(Property(d,"PropertyName")));
        }
        var scripts=new List<object>();
        foreach(object handler in (IEnumerable)Property(item,"EventHandlers")) {
            object script=Property(handler,"Script");
            scripts.Add(new{eventType=Convert.ToString(Property(handler,"EventType")),code=Property(script,"ScriptCode"),globalCode=Property(script,"GlobalDefinitionAreaScriptCode"),async=Property(script,"Async")});
        }
        return new Dictionary<string,object>{{"objectType",item.GetType().FullName},{"name",Property(item,"Name")},{"properties",properties},
            {"dynamicProperties",dynamicProperties.OrderBy(s=>s,StringComparer.Ordinal).ToArray()},{"bindings",bindings},{"eventScripts",scripts},{"screenWidth",screen.Width},{"screenHeight",screen.Height}};
    }
    static Device UnifiedHostingDevice(HmiSoftware target) {
        object cursor=target;
        for(int i=0;i<12 && cursor!=null;i++) { if(cursor is Device) return (Device)cursor; var p=cursor.GetType().GetProperty("Parent"); cursor=p==null?null:p.GetValue(cursor,null); }
        throw new Exception("Unable to resolve exact Unified hosting device.");
    }
    static void SetUnifiedProperty(object item,Language language,string key,object value) {
        switch(key) {
            case "Text": ((MultilingualText)Property(item,"Text")).Items.Find(language).Text=Convert.ToString(value); break;
            case "FontSize": ((HmiFontPart)Property(item,"Font")).Size=Convert.ToSingle(value); break;
            case "BackColor": case "ForeColor": item.GetType().GetProperty(key).SetValue(item,Color.FromArgb(unchecked((int)UInt32.Parse(Convert.ToString(value).Substring(1),NumberStyles.HexNumber))),null); break;
            case "Left": case "Top": case "Width": case "Height": Put(item,key,value); break;
            default: throw new Exception("Unsupported Unified edit property.");
        }
    }
    static void AccessUnified(Dictionary<string,object> request) {
        int pid=Convert.ToInt32(request["processId"]); string expectedPath=Path.GetFullPath(S(request,"projectPath"));
        DateTime start=DateTime.Parse(S(request,"processStartTimeUtc"),null,DateTimeStyles.RoundtripKind).ToUniversalTime();
        if(Process.GetProcessById(pid).StartTime.ToUniversalTime()!=start) throw new Exception("Unified process identity mismatch.");
        using(var portal=One(TiaPortal.GetProcesses(),p=>p.Id==pid,"TIA Portal Openness process "+pid).Attach()) {
            var project=One(portal.Projects,p=>String.Equals(Path.GetFullPath(p.Path.FullName),expectedPath,StringComparison.OrdinalIgnoreCase),"Open project "+expectedPath);
            var targets=UnifiedTargets(project);
            if(String.IsNullOrEmpty(S(request,"targetPath"))) {
                CheckIdentity(project,pid,start,expectedPath);
                Console.WriteLine(Json.Serialize(new{ok=true,targets=targets.Select(t=>new{path=t.Item2,name=t.Item1.Name}).ToArray(),projectModified=false})); return;
            }
            var target=One(targets,t=>t.Item2==S(request,"targetPath"),"Unified target '"+S(request,"targetPath")+"' (an empty targetPath lists exact paths)").Item1;
            var screens=UnifiedScreens(target);
            if(String.IsNullOrEmpty(S(request,"screenPath"))) {
                CheckIdentity(project,pid,start,expectedPath);
                Console.WriteLine(Json.Serialize(new{ok=true,screens=screens.Select(s=>new{path=s.Item2,number=s.Item1.ScreenNumber,width=s.Item1.Width,height=s.Item1.Height}).ToArray(),projectModified=false})); return;
            }
            var screen=One(screens,s=>s.Item2==S(request,"screenPath"),"Unified screen '"+S(request,"screenPath")+"' (an empty screenPath lists exact paths)").Item1;
            if(String.IsNullOrEmpty(S(request,"objectName"))) {
                CheckIdentity(project,pid,start,expectedPath);
                Console.WriteLine(Json.Serialize(new{ok=true,objects=screen.ScreenItems.Select(i=>new{name=i.Name,type=i.GetType().FullName}).ToArray(),projectModified=false})); return;
            }
            object item=screen.ScreenItems.Find(S(request,"objectName")); if(item==null) throw new Exception("Unified object not found.");
            if(S(request,"operation")=="inspect_unified") {
                var snapshot=UnifiedObjectSnapshot(project,screen,item,S(request,"language")); CheckIdentity(project,pid,start,expectedPath);
                Console.WriteLine(Json.Serialize(new{ok=true,observation=snapshot,baselineSha256=Hash(Json.Serialize(snapshot)),nativeImportArchive=false,coverage="scoped_public_properties",projectModified=false})); return;
            }
            if(S(request,"operation")!="edit_unified") throw new Exception("Unsupported Unified access operation.");
            using(var access=portal.ExclusiveAccess("Apply exact Unified object property plan")) {
                CheckIdentity(project,pid,start,expectedPath);
                var original=UnifiedObjectSnapshot(project,screen,item,S(request,"language"));
                if(Hash(Json.Serialize(original))!=S(D(request["baseline"]),"baselineSha256")) throw new Exception("Stale Unified baseline.");
                var properties=D(request["properties"]); var existing=D(original["properties"]); var dynamicProperties=(string[])original["dynamicProperties"];
                foreach(var entry in properties) {
                    if(!existing.ContainsKey(entry.Key)) throw new Exception("Unavailable Unified edit property.");
                    if(dynamicProperties.Contains(entry.Key=="FontSize"?"Font.Size":entry.Key)) throw new Exception("Cannot replace a dynamically bound property.");
                }
                var compiler=UnifiedHostingDevice(target).GetService<ICompilable>(); if(compiler==null) throw new Exception("Hosting-device compiler unavailable.");
                string recovery=Path.GetFullPath(S(request,"recoveryDirectory")); Directory.CreateDirectory(recovery);
                string before=Path.Combine(recovery,"original-properties.json"); if(File.Exists(before)) throw new Exception("Recovery path already used.");
                File.WriteAllText(before,Json.Serialize(original),new UTF8Encoding(false));
                File.WriteAllText(Path.Combine(recovery,"approved-changes.json"),Json.Serialize(properties),new UTF8Encoding(false));
                if(access.IsCancellationRequested) throw new OperationCanceledException("Cancelled before Unified edit.");
                mutationAttempted=true;
                var language=UnifiedLanguage(project,S(request,"language"),false);
                foreach(var entry in properties) {SetUnifiedProperty(item,language,entry.Key,entry.Value);existing[entry.Key]=entry.Value;}
                var compiled=compiler.Compile(); var messages=new List<object>(); Messages(compiled.Messages,messages,0);
                var after=UnifiedObjectSnapshot(project,screen,item,S(request,"language"));
                File.WriteAllText(Path.Combine(recovery,"readback-properties.json"),Json.Serialize(after),new UTF8Encoding(false));
                bool matches=Hash(Json.Serialize(after))==Hash(Json.Serialize(original));
                bool ok=matches&&compiled.ErrorCount==0&&compiled.State!=CompilerResultState.Error;
                CheckIdentity(project,pid,start,expectedPath);
                if(access.IsCancellationRequested) throw new OperationCanceledException("Cancelled after Unified edit; fresh readback required.");
                if(ok&&Convert.ToBoolean(request["saveProject"])) project.Save();
                Console.WriteLine(Json.Serialize(new{ok=ok,status=ok?"applied":"verification_failed",projectModified=true,saved=ok&&Convert.ToBoolean(request["saveProject"]),
                    compile=new{state=compiled.State.ToString(),errors=compiled.ErrorCount,warnings=compiled.WarningCount,messages=messages},
                    readbackMatches=matches,readbackSha256=Hash(Json.Serialize(after)),recoveryDirectory=recovery,rollbackAttempted=false,downloaded=false}));
            }
        }
    }
}
