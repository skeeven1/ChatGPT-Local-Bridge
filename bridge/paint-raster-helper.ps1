param(
  [Parameter(Mandatory=$true)][string]$PlanPath
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$source = @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Text;
using System.Threading;
using System.Windows.Forms;

[DataContract] public class RasterPlan {
  [DataMember] public string version;
  [DataMember] public string jobId;
  [DataMember] public string statusPath;
  [DataMember] public string controlPath;
  [DataMember] public long paintHwnd;
  [DataMember] public string paintTitle;
  [DataMember] public RectPlan windowBounds;
  [DataMember] public RectPlan canvas;
  [DataMember] public int originX;
  [DataMember] public int originY;
  [DataMember] public int rasterWidth;
  [DataMember] public int rasterHeight;
  [DataMember] public string paletteProfile;
  [DataMember] public string quality;
  [DataMember] public int segmentCount;
  [DataMember] public int batchEvery;
  [DataMember] public int batchDelayMs;
  [DataMember] public List<GroupPlan> groups;
}
[DataContract] public class RectPlan { [DataMember] public int x; [DataMember] public int y; [DataMember] public int width; [DataMember] public int height; }
[DataContract] public class GroupPlan {
  [DataMember] public string name;
  [DataMember] public string hex;
  [DataMember] public int r;
  [DataMember] public int g;
  [DataMember] public int b;
  [DataMember] public List<SegmentPlan> segments;
}
[DataContract] public class SegmentPlan { [DataMember] public int x1; [DataMember] public int x2; [DataMember] public int y; }

public sealed class BlueBorderForm : Form {
  public int PointerX, PointerY; public bool PointerVisible;
  readonly Pen border = new Pen(Color.FromArgb(36, 145, 255), 4f);
  readonly Pen cross = new Pen(Color.FromArgb(58, 190, 255), 3f);
  readonly SolidBrush dot = new SolidBrush(Color.FromArgb(230, 25, 120, 255));
  public BlueBorderForm(Rectangle bounds) {
    FormBorderStyle=FormBorderStyle.None; ShowInTaskbar=false; TopMost=true; StartPosition=FormStartPosition.Manual; Bounds=bounds;
    BackColor=Color.Fuchsia; TransparencyKey=Color.Fuchsia; DoubleBuffered=true;
  }
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams { get { const int T=0x20,W=0x80,L=0x80000,N=0x08000000; var cp=base.CreateParams; cp.ExStyle|=T|W|L|N; return cp; } }
  public void SetPointer(int sx,int sy,bool visible){PointerX=sx-Bounds.Left;PointerY=sy-Bounds.Top;PointerVisible=visible;Invalidate();}
  protected override void OnPaint(PaintEventArgs e){base.OnPaint(e);e.Graphics.SmoothingMode=SmoothingMode.AntiAlias;var r=ClientRectangle;r.Inflate(-2,-2);e.Graphics.DrawRectangle(border,r);if(PointerVisible){int q=10;e.Graphics.DrawEllipse(cross,PointerX-q,PointerY-q,q*2,q*2);e.Graphics.DrawLine(cross,PointerX-18,PointerY,PointerX+18,PointerY);e.Graphics.DrawLine(cross,PointerX,PointerY-18,PointerX,PointerY+18);e.Graphics.FillEllipse(dot,PointerX-3,PointerY-3,6,6);}}
}

public sealed class ControlPanelForm : Form {
  public Label TitleLabel, StatusLabel, DetailLabel; public ProgressBar Progress; public Button PauseButton, StopButton;
  public Action TogglePauseAction, StopAction;
  public ControlPanelForm(Rectangle paintRect){
    FormBorderStyle=FormBorderStyle.None; ShowInTaskbar=false; TopMost=true; StartPosition=FormStartPosition.Manual; Width=300; Height=112;
    int x=Math.Max(SystemInformation.VirtualScreen.Left+8, Math.Min(paintRect.Right-Width-12, paintRect.Left+10)); int y=Math.Max(SystemInformation.VirtualScreen.Top+8,paintRect.Top+8); Location=new Point(x,y);
    BackColor=Color.FromArgb(22,25,31); ForeColor=Color.White; Padding=new Padding(14);
    TitleLabel=new Label(){Text="ChatGPT Local Bridge",AutoSize=false,Left=14,Top=10,Width=170,Height=22,Font=new Font("Segoe UI",10.5f,FontStyle.Bold),ForeColor=Color.White};
    StatusLabel=new Label(){Text="Raster drawing",AutoSize=false,Left=14,Top=35,Width=170,Height=20,Font=new Font("Segoe UI",9f),ForeColor=Color.FromArgb(190,220,255)};
    DetailLabel=new Label(){Text="Move your mouse to pause",AutoSize=false,Left=14,Top=57,Width=170,Height=18,Font=new Font("Segoe UI",8f),ForeColor=Color.FromArgb(170,175,185)};
    Progress=new ProgressBar(){Left=14,Top=82,Width=272,Height=10,Minimum=0,Maximum=100,Value=0,Style=ProgressBarStyle.Continuous};
    PauseButton=new Button(){Text="Pause  F8",Left=190,Top=17,Width=96,Height=28,FlatStyle=FlatStyle.Flat,BackColor=Color.FromArgb(29,111,214),ForeColor=Color.White}; PauseButton.FlatAppearance.BorderSize=0; PauseButton.FlatAppearance.MouseOverBackColor=Color.FromArgb(39,131,235);
    StopButton=new Button(){Text="Stop  F9",Left=190,Top=49,Width=96,Height=28,FlatStyle=FlatStyle.Flat,BackColor=Color.FromArgb(52,57,66),ForeColor=Color.White}; StopButton.FlatAppearance.BorderSize=0; StopButton.FlatAppearance.MouseOverBackColor=Color.FromArgb(72,77,88);
    PauseButton.Click+=(s,e)=>{if(TogglePauseAction!=null)TogglePauseAction();}; StopButton.Click+=(s,e)=>{if(StopAction!=null)StopAction();}; Controls.AddRange(new Control[]{TitleLabel,StatusLabel,DetailLabel,Progress,PauseButton,StopButton});
  }
  protected override void OnResize(EventArgs e){base.OnResize(e);int r=16;var gp=new GraphicsPath();gp.AddArc(0,0,r,r,180,90);gp.AddArc(Width-r,0,r,r,270,90);gp.AddArc(Width-r,Height-r,r,r,0,90);gp.AddArc(0,Height-r,r,r,90,90);gp.CloseFigure();Region=new Region(gp);gp.Dispose();}
  protected override void OnPaint(PaintEventArgs e){base.OnPaint(e);using(var b=new SolidBrush(Color.FromArgb(36,145,255)))e.Graphics.FillRectangle(b,0,0,Width,3);}
  protected override void WndProc(ref Message m){const int WM_HOTKEY=0x0312;if(m.Msg==WM_HOTKEY){if(m.WParam.ToInt32()==1){if(TogglePauseAction!=null)TogglePauseAction();}else if(m.WParam.ToInt32()==2){if(StopAction!=null)StopAction();}}base.WndProc(ref m);}
}

public static class RasterRunner {
  const int WH_MOUSE_LL=14, WM_MOUSEMOVE=0x0200, WM_LBUTTONDOWN=0x0201, WM_RBUTTONDOWN=0x0204, WM_MBUTTONDOWN=0x0207;
  const uint INPUT_MOUSE=0, M_MOVE=0x0001, M_LEFTDOWN=0x0002, M_LEFTUP=0x0004, M_ABSOLUTE=0x8000, M_VIRTUALDESK=0x4000;
  const uint LLMHF_INJECTED=0x00000001;
  static readonly UIntPtr MAGIC = new UIntPtr(0x434C4252u);
  static volatile bool paused=false, stopped=false, drawing=false, ownButtonDown=false; static string pauseReason="";
  static BlueBorderForm border; static ControlPanelForm panel; static RasterPlan plan; static Thread drawingThread; static IntPtr hook=IntPtr.Zero; static LowLevelMouseProc hookProc;
  static int completed=0; static DateTime lastStatus=DateTime.MinValue; static Dictionary<string,Point> palettePoints=new Dictionary<string,Point>(StringComparer.OrdinalIgnoreCase);

  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left,Top,Right,Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X,Y; }
  [StructLayout(LayoutKind.Sequential)] struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData,flags,time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public MOUSEINPUT mi; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx,dy; public uint mouseData,dwFlags,time; public UIntPtr dwExtraInfo; }
  delegate IntPtr LowLevelMouseProc(int nCode,IntPtr wParam,IntPtr lParam);
  [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id,LowLevelMouseProc cb,IntPtr mod,uint tid);
  [DllImport("kernel32.dll", CharSet=CharSet.Auto)] static extern IntPtr GetModuleHandle(string lpModuleName);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h,int code,IntPtr wp,IntPtr lp);
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h,out RECT r);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h,int cmd);
  [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr hWnd,int id,uint mods,uint vk);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk,byte scan,uint flags,UIntPtr extra);
  [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr hWnd,int id);

  public static RasterPlan Load(string path){using(var fs=File.OpenRead(path)){var s=new DataContractJsonSerializer(typeof(RasterPlan));return (RasterPlan)s.ReadObject(fs);}}
  static string Esc(string s){return (s??"").Replace("\\","\\\\").Replace("\"","\\\"").Replace("\r"," ").Replace("\n"," ");}
  static void WriteStatus(string state,string reason=""){
    try{double p=plan.segmentCount<=0?0:100.0*completed/plan.segmentCount;string json="{\n\"jobId\":\""+Esc(plan.jobId)+"\",\"state\":\""+Esc(state)+"\",\"progress\":"+p.ToString("0.0",System.Globalization.CultureInfo.InvariantCulture)+",\"completedSegments\":"+completed+",\"segmentCount\":"+plan.segmentCount+",\"reason\":\""+Esc(reason)+"\",\"updatedAt\":\""+DateTime.UtcNow.ToString("o")+"\"\n}";string tmp=plan.statusPath+".tmp";File.WriteAllText(tmp,json,Encoding.UTF8);if(File.Exists(plan.statusPath))File.Delete(plan.statusPath);File.Move(tmp,plan.statusPath);}catch{}
  }
  static Rectangle PaintRect(){RECT r; if(!GetWindowRect(new IntPtr(plan.paintHwnd),out r))return new Rectangle(plan.canvas.x,plan.canvas.y,plan.canvas.width,plan.canvas.height);return Rectangle.FromLTRB(r.Left,r.Top,r.Right,r.Bottom);}
  static void RecalibrateIfMoved(){
    Rectangle current=PaintRect();
    if(plan.windowBounds==null){plan.windowBounds=new RectPlan(){x=current.X,y=current.Y,width=current.Width,height=current.Height};return;}
    if(current.X==plan.windowBounds.x&&current.Y==plan.windowBounds.y&&current.Width==plan.windowBounds.width&&current.Height==plan.windowBounds.height)return;
    if(current.Width<240||current.Height<180)throw new Exception("Paint window bounds became invalid");
    double sx=current.Width/(double)Math.Max(1,plan.windowBounds.width),sy=current.Height/(double)Math.Max(1,plan.windowBounds.height);
    plan.canvas.x=current.X+(int)Math.Round((plan.canvas.x-plan.windowBounds.x)*sx);
    plan.canvas.y=current.Y+(int)Math.Round((plan.canvas.y-plan.windowBounds.y)*sy);
    plan.canvas.width=Math.Max(64,(int)Math.Round(plan.canvas.width*sx));
    plan.canvas.height=Math.Max(64,(int)Math.Round(plan.canvas.height*sy));
    plan.originX=plan.canvas.x+(plan.canvas.width-plan.rasterWidth)/2;
    plan.originY=plan.canvas.y+(plan.canvas.height-plan.rasterHeight)/2;
    plan.windowBounds.x=current.X;plan.windowBounds.y=current.Y;plan.windowBounds.width=current.Width;plan.windowBounds.height=current.Height;
    palettePoints.Clear();
    WriteStatus("running","recalibrated after Paint moved or resized");
  }
  static void Ui(Action a){if(panel==null)return;if(panel.InvokeRequired)panel.BeginInvoke(a);else a();}
  static void SetPaused(bool v,string reason){paused=v;pauseReason=v?reason:"";if(v&&ownButtonDown)MouseUp();Ui(()=>{panel.StatusLabel.Text=v?"Paused — you have the mouse":"Drawing pixels…";panel.DetailLabel.Text=v?"F8 / Resume to continue":"Move your mouse to pause instantly";panel.PauseButton.Text=v?"Resume  F8":"Pause  F8";});WriteStatus(v?"paused":"running",pauseReason);}
  static void TogglePause(){if(stopped)return;SetPaused(!paused,paused?"":"manual pause");}
  static void Stop(){stopped=true;if(ownButtonDown)MouseUp();Ui(()=>{panel.StatusLabel.Text="Stopping…";panel.DetailLabel.Text="The drawing job is stopping safely";});WriteStatus("stopping","user stop");}
  static IntPtr Hook(int code,IntPtr wp,IntPtr lp){if(code>=0&&drawing&&!stopped){var m=(MSLLHOOKSTRUCT)Marshal.PtrToStructure(lp,typeof(MSLLHOOKSTRUCT));bool ours=(m.dwExtraInfo.ToUInt64()==MAGIC.ToUInt64());int msg=wp.ToInt32();if(!ours&&(msg==WM_MOUSEMOVE||msg==WM_LBUTTONDOWN||msg==WM_RBUTTONDOWN||msg==WM_MBUTTONDOWN)&&!paused){SetPaused(true,"physical mouse movement");}}return CallNextHookEx(hook,code,wp,lp);}
  static void Send(uint flags,int sx,int sy){Rectangle v=SystemInformation.VirtualScreen;bool move=(flags&M_MOVE)!=0;int dx=move?(int)Math.Round((sx-v.Left)*65535.0/Math.Max(1,v.Width-1)):0;int dy=move?(int)Math.Round((sy-v.Top)*65535.0/Math.Max(1,v.Height-1)):0;uint actual=move?(flags|M_ABSOLUTE|M_VIRTUALDESK):flags;INPUT i=new INPUT(){type=INPUT_MOUSE,mi=new MOUSEINPUT(){dx=dx,dy=dy,mouseData=0,dwFlags=actual,time=0,dwExtraInfo=MAGIC}};if(SendInput(1,new INPUT[]{i},Marshal.SizeOf(typeof(INPUT)))==0)throw new Exception("SendInput failed");}
  static void Move(int x,int y){Send(M_MOVE,x,y);Ui(()=>border.SetPointer(x,y,true));}
  static void MouseDown(){Send(M_LEFTDOWN,0,0);ownButtonDown=true;}
  static void MouseUp(){Send(M_LEFTUP,0,0);ownButtonDown=false;}
  static void Click(Point p){Move(p.X,p.Y);Thread.Sleep(8);MouseDown();Thread.Sleep(3);MouseUp();Thread.Sleep(35);}

  static Bitmap ToolbarShot(Rectangle wr,out Rectangle area){int left=wr.Left+(int)(wr.Width*0.46),right=wr.Left+(int)(wr.Width*0.73);int top=wr.Top+28,bottom=Math.Min(wr.Bottom,wr.Top+132);area=Rectangle.FromLTRB(left,top,right,bottom);var b=new Bitmap(area.Width,area.Height,PixelFormat.Format24bppRgb);using(var g=Graphics.FromImage(b))g.CopyFromScreen(area.Left,area.Top,0,0,area.Size,CopyPixelOperation.SourceCopy);return b;}
  static Point FindColor(Bitmap bmp,Rectangle area,Color target){long best=long.MaxValue;Point bp=Point.Empty;for(int y=4;y<bmp.Height-4;y+=2)for(int x=4;x<bmp.Width-4;x+=2){Color c=bmp.GetPixel(x,y);long dr=c.R-target.R,dg=c.G-target.G,db=c.B-target.B;long s=dr*dr*30+dg*dg*59+db*db*11;if(s<best){best=s;bp=new Point(area.Left+x,area.Top+y);}}if(best>600000)throw new Exception("Paint palette color not found: "+target);return bp;}
  static Color Hex(string h){return ColorTranslator.FromHtml(h);}
  static void DetectPalette(){Rectangle wr=PaintRect(),area;using(var b=ToolbarShot(wr,out area)){foreach(var g in plan.groups){if(palettePoints.ContainsKey(g.hex))continue;palettePoints[g.hex]=FindColor(b,area,Color.FromArgb(g.r,g.g,g.b));}}}
  static void TryFocusAndPencil(){var h=new IntPtr(plan.paintHwnd);ShowWindow(h,9);SetForegroundWindow(h);Thread.Sleep(180); /* Force the current Paint drawing tool to its minimum width. */ for(int i=0;i<14;i++){keybd_event(0x11,0,0,UIntPtr.Zero);keybd_event(0xBD,0,0,UIntPtr.Zero);keybd_event(0xBD,0,2,UIntPtr.Zero);keybd_event(0x11,0,2,UIntPtr.Zero);}Thread.Sleep(100);}
  static void CheckControlFile(){try{if(String.IsNullOrEmpty(plan.controlPath)||!File.Exists(plan.controlPath))return;string txt=File.ReadAllText(plan.controlPath).ToLowerInvariant();File.Delete(plan.controlPath);if(txt.Contains("stop"))Stop();else if(txt.Contains("resume"))SetPaused(false,"");else if(txt.Contains("pause"))SetPaused(true,"remote pause");}catch{}}
  static void WaitIfPaused(){while(paused&&!stopped){CheckControlFile();Thread.Sleep(80);} }
  static void DrawSegment(SegmentPlan s){int y=plan.originY+s.y,x1=plan.originX+s.x1,x2=plan.originX+s.x2;Move(x1,y);if(x1==x2){MouseDown();Thread.Sleep(1);MouseUp();return;}MouseDown();Thread.Sleep(1);Move(x2,y);Thread.Sleep(1);MouseUp();}
  static void Drawing(){
    drawing=true;try{TryFocusAndPencil();RecalibrateIfMoved();DetectPalette();WriteStatus("running");int batch=Math.Max(15,plan.batchEvery),delay=Math.Max(0,plan.batchDelayMs);
      foreach(var g in plan.groups){if(stopped)break;WaitIfPaused();CheckControlFile();if(stopped)break;Point sw=palettePoints[g.hex];Click(sw);int rowN=0;
        foreach(var s in g.segments){if(stopped)break;WaitIfPaused();CheckControlFile();if(stopped)break;DrawSegment(s);completed++;rowN++;
          if(completed%batch==0){RecalibrateIfMoved();if(palettePoints.Count==0)DetectPalette();if(delay>0)Thread.Sleep(delay);double pct=plan.segmentCount<=0?0:100.0*completed/plan.segmentCount;Ui(()=>{panel.Progress.Value=Math.Max(0,Math.Min(100,(int)pct));panel.StatusLabel.Text="Drawing pixels… "+pct.ToString("0")+"%";panel.DetailLabel.Text=g.name+" • "+completed+" / "+plan.segmentCount+" runs";});WriteStatus(paused?"paused":"running",pauseReason);}
        }
      }
      if(ownButtonDown)MouseUp(); if(stopped)WriteStatus("stopped","user stop");else{completed=plan.segmentCount;WriteStatus("done");Ui(()=>{panel.Progress.Value=100;panel.StatusLabel.Text="Done";panel.DetailLabel.Text="Raster drawing completed";});Thread.Sleep(1200);}
    }catch(Exception ex){if(ownButtonDown)MouseUp();WriteStatus("error",ex.Message);Ui(()=>{panel.StatusLabel.Text="Error";panel.DetailLabel.Text=ex.Message.Length>70?ex.Message.Substring(0,70):ex.Message;});Thread.Sleep(2500);}finally{drawing=false;Ui(()=>{try{border.Hide();panel.Close();}catch{}});}
  }
  public static void Run(string planPath){plan=Load(planPath);Rectangle wr=PaintRect();Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);border=new BlueBorderForm(wr);panel=new ControlPanelForm(wr);panel.TogglePauseAction=TogglePause;panel.StopAction=Stop;panel.Shown+=(s,e)=>{border.Show();border.BringToFront();panel.BringToFront();RegisterHotKey(panel.Handle,1,0,0x77);RegisterHotKey(panel.Handle,2,0,0x78);hookProc=Hook;hook=SetWindowsHookEx(WH_MOUSE_LL,hookProc,GetModuleHandle(null),0);drawingThread=new Thread(Drawing);drawingThread.IsBackground=true;drawingThread.Start();};panel.FormClosed+=(s,e)=>{stopped=stopped||drawing;if(hook!=IntPtr.Zero)UnhookWindowsHookEx(hook);try{UnregisterHotKey(panel.Handle,1);UnregisterHotKey(panel.Handle,2);}catch{}};Application.Run(panel);}
}
'@

Add-Type -TypeDefinition $source -ReferencedAssemblies @('System.Windows.Forms.dll','System.Drawing.dll','System.Runtime.Serialization.dll') -Language CSharp
[RasterRunner]::Run((Resolve-Path -LiteralPath $PlanPath).Path)
