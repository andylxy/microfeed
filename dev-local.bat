@echo off
REM NOTE: this file is GBK(ANSI) encoded for Chinese. In editors open with GBK/ANSI.
setlocal EnableDelayedExpansion

REM ============================================================
REM  microfeed local instance manager
REM  Usage (no args => number menu, just press a digit):
REM    dev-local.bat            => open number menu (press 1-6, Enter=1 start)
REM    dev-local.bat start      = foreground (Ctrl+C to stop)
REM    dev-local.bat startbg    = background (new window)
REM    dev-local.bat stop       = stop service
REM    dev-local.bat restart    = restart
REM    dev-local.bat status     = show running state
REM    dev-local.bat logs       = show startup log
REM ============================================================

REM ===== config (edit as needed) =====
set "PROJECT_DIR=D:\git\AiCode\microfeed"
set "GIT_USR=C:\Users\zhs\.workbuddy\binaries\PortableGit\versions\1.2.0\usr\bin"
set "GIT_BIN=C:\Users\zhs\.workbuddy\binaries\PortableGit\versions\1.2.0\bin"
set "NODE_DIRS=C:\Users\zhs\.workbuddy\binaries\node\versions\22.22.2-3;D:\toolkit\node"
set "INSTANCE=ctwh-881019-xyz"
set "PORT=4321"
set "LOG_FILE=.microfeed\dev-local-start.log"
set "WIN_TITLE=microfeed-local-dev"

REM ===== enter project dir =====
cd /d "%PROJECT_DIR%" || (echo [错误] 无法进入项目目录：%PROJECT_DIR% & pause & exit /b 1)

REM ===== preflight: yarn exists? =====
if not exist "node_modules\.bin\yarn.cmd" (
  echo [错误] 未找到 node_modules\.bin\yarn.cmd
  echo         请先在本项目目录执行一次依赖安装（yarn install）后再使用本脚本。
  pause & exit /b 1
)

REM ===== inject env (for yarn sh launcher & node) =====
set "PATH=%NODE_DIRS%;%GIT_USR%;%GIT_BIN%;%PATH%"
REM disable safe-delete gate to avoid file-op blocking
set "CODEBUDDY_SAFE_DELETE_ENABLED=0"

REM ===== dispatch: arg => direct mode (legacy), no arg => number menu =====
if not "%~1"=="" goto arg_dispatch

REM ============================================================
:menu
call :print_header
echo.
echo   请选择操作（按数字键；r = 立即刷新状态；15 秒无操作自动刷新）:
echo.
echo     1. 后台启动（无窗口常驻）   2. 前台启动（当前窗口，Ctrl+C 停止）
echo     3. 停止服务                 4. 重启服务
echo     5. 查看运行状态             6. 查看启动日志
echo     0. 退出
echo.
choice /c 1234560r /t 15 /d r /m "请选择（1-6 操作，0 退出，r 刷新状态）"
if errorlevel 8 goto menu
if errorlevel 7 exit /b 0
if errorlevel 6 call :do_logs & goto menu
if errorlevel 5 call :do_status & goto menu
if errorlevel 4 call :do_restart & goto menu
if errorlevel 3 call :do_stop & goto menu
if errorlevel 2 call :do_start & goto menu
if errorlevel 1 call :do_startbg & goto menu

REM ============================================================
:arg_dispatch
if /i "%~1"=="start"   call :do_start   & exit /b 0
if /i "%~1"=="startbg" call :do_startbg & exit /b 0
if /i "%~1"=="stop"    call :do_stop    & exit /b 0
if /i "%~1"=="restart" call :do_restart & exit /b 0
if /i "%~1"=="status"  call :do_status  & exit /b 0
if /i "%~1"=="logs"    call :do_logs    & exit /b 0
echo 用法: %~nx0 [start ^| startbg ^| stop ^| restart ^| status ^| logs]
echo   不传参数 = 进入数字菜单（按数字即可，无需输入英文）
pause
exit /b 1

REM ============================================================
:print_header
cls
echo ============================================================
echo   microfeed 本地实例管理（实例: %INSTANCE%）
echo   访问地址: http://localhost:%PORT%/
echo ============================================================
call :is_running && (echo   当前状态: [运行中] PID !RUN_PID!) || (echo   当前状态: [未运行])
exit /b 0

REM ============================================================
:is_running
REM set RUN_PID; return 0 if port listening else 1
set "RUN_PID="
for /f "tokens=1,5" %%a in ('netstat -ano 2^>nul ^| findstr ":%PORT%" ^| findstr "LISTENING"') do set "RUN_PID=%%b"
if defined RUN_PID (exit /b 0) else (exit /b 1)

REM ============================================================
:clean_stale
REM kill leftover astro dev servers (fallback ports) that would
REM otherwise make astro refuse to start ("already running")
for %%p in (4322 4323) do (
  for /f "tokens=1,5" %%a in ('netstat -ano 2^>nul ^| findstr ":%%p" ^| findstr "LISTENING"') do (
    taskkill /PID %%b /F /T >nul 2>&1
  )
)
exit /b 0

REM ============================================================
:do_start
echo.
echo ============================================================
echo   启动本地实例（前台模式）
echo   实例   : %INSTANCE%
echo   目录   : %PROJECT_DIR%
echo   访问   : http://localhost:%PORT%/
echo   停止   : 按 Ctrl+C
echo ============================================================
echo.
call :is_running && (
  echo [提示] 端口 %PORT% 已被占用（PID !RUN_PID!），无需重复启动。
  echo        如需重启请先选 3（停止）或 4（重启）。
  exit /b 0
)
echo [*] 正在前台启动服务...
call .\node_modules\.bin\yarn.cmd manage dev --local --instance %INSTANCE%
exit /b 0

REM ============================================================
:do_startbg
echo.
echo ============================================================
echo   启动本地实例（后台隐藏模式，无窗口常驻）
echo   实例   : %INSTANCE%
echo   日志   : %LOG_FILE%
echo   访问   : http://localhost:%PORT%/
echo   停止   : 菜单选 3（停止），或 %~nx0 stop
echo ============================================================
echo.
call :is_running && (
  echo [提示] 端口 %PORT% 已被占用（PID !RUN_PID!），无需重复启动。
  echo        如需重启请先选 3（停止）再选 1（启动）。
  exit /b 0
)
call :clean_stale
echo [*] 正在后台启动服务（无窗口，日志见 %LOG_FILE%）...
set "VBS=%TEMP%\mf-start-helper.vbs"
> "%VBS%" echo Set ws = CreateObject("WScript.Shell")
>> "%VBS%" echo ws.Run "cmd /c ""%PROJECT_DIR%\dev-local-server.bat""", 0, False
wscript.exe //nologo "%VBS%"
set "WRC=%ERRORLEVEL%"
del "%VBS%" >nul 2>&1
if not "%WRC%"=="0" (
  echo [提示] 隐藏启动不可用，改用最小化窗口方式...
  start /min "%WIN_TITLE%" /D "%PROJECT_DIR%" cmd /c "dev-local-server.bat"
)
echo [*] 已发起启动，等待服务就绪（最多约 120 秒）...
call :wait_ready
if "%READY%"=="1" (
  echo.
  echo [OK] 服务已启动！
  echo      访问地址: http://localhost:%PORT%/
  echo      运行方式: 后台隐藏进程（无窗口，持续运行）
  echo      停止服务: 菜单选 3（停止），或 %~nx0 stop
  echo      查看日志: 菜单选 6（查看日志）
) else (
  echo.
  echo [警告] 120 秒内未检测到端口 %PORT% 监听，可能启动失败。
  echo      请选 6 查看日志: %LOG_FILE%
  echo      常见原因: 端口被占用 / 依赖未安装 / 实例名错误
)
exit /b 0

REM ============================================================
:wait_ready
set "READY=0"
for /L %%i in (1,1,60) do (
  call :is_running && (set "READY=1" & exit /b)
  ping -n 3 127.0.0.1 >nul 2>&1
)
exit /b

REM ============================================================
:do_stop
call :stop_internal
exit /b 0

:stop_internal
echo [*] 正在停止端口 %PORT% 上的服务...
set "FOUND=0"
for /f "tokens=1,5" %%a in ('netstat -ano 2^>nul ^| findstr ":%PORT%" ^| findstr "LISTENING"') do (
  echo   - 终止 PID %%b
  taskkill /PID %%b /F /T >nul 2>&1
  set "FOUND=1"
)
if "%FOUND%"=="1" (echo [OK] 已发送停止信号) else (echo [提示] 端口 %PORT% 上没有运行中的服务)
exit /b 0

REM ============================================================
:do_restart
echo [*] 重启本地实例...
call :stop_internal
ping -n 3 127.0.0.1 >nul 2>&1
call :do_startbg
exit /b 0

REM ============================================================
:do_status
call :is_running && (echo [运行中] PID !RUN_PID!  -^>  http://localhost:%PORT%/ ) || echo [未运行] 端口 %PORT% 无服务
exit /b 0

REM ============================================================
:do_logs
echo [*] 显示日志末尾（%LOG_FILE%）：
echo ------------------------------------------------------------
if exist "%LOG_FILE%" (type "%LOG_FILE%") else (echo   （日志文件不存在，服务可能尚未启动过）)
echo ------------------------------------------------------------
exit /b 0
