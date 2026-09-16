@echo off
chcp 936 >nul
setlocal enabledelayedexpansion

rem ===================================================================
rem  Nyx 更新 · D-233
rem  双击这个文件，就会重新打包，并把正在用的那个版本替换掉。
rem  data\ 和 dicts\ 一个字节都不动 —— 学习数据和词典留在原处。
rem
rem  这个文件必须是 GBK 编码。存成 UTF-8 的话，中文在命令行窗口里全是乱码。
rem ===================================================================

cd /d "%~dp0"

rem ── 装 Nyx 的地方。想换位置就改下面这一行 ───────────────────────
set "TARGET=D:\Nyx"

echo.
echo   Nyx 更新
echo   源码：%CD%
echo   装到：%TARGET%
echo.

rem ── 1 · 有没有 node ──────────────────────────────────────────────
where npm >nul 2>nul
if errorlevel 1 (
  echo   [x] 这台机器上找不到 npm。
  echo.
  echo       去 https://nodejs.org 下载 LTS 版装一下，装完重开这个文件。
  echo.
  pause
  exit /b 1
)

rem ── 2 · 关掉正在运行的 Nyx（不关的话文件被占用，替换会失败）─────
tasklist /fi "imagename eq Nyx.exe" | find /i "Nyx.exe" >nul
if not errorlevel 1 (
  echo   [1/4] Nyx 正开着，先关掉…
  taskkill /f /im Nyx.exe >nul 2>nul
  timeout /t 2 /nobreak >nul
) else (
  echo   [1/4] Nyx 没在运行，跳过。
)

rem ── 3 · 打包 ────────────────────────────────────────────────────
echo   [2/4] 正在打包（第一次会慢一点）…
call npm run package
if errorlevel 1 (
  echo.
  echo   [x] 打包失败了。上面那一大段红字就是原因，
  echo       整段复制下来发给 Claude Code。
  echo.
  echo       你的数据没有被动过 —— 现在装着的那个版本还能正常用。
  echo.
  pause
  exit /b 1
)

set "BUILT=%CD%\release\win-unpacked"
if not exist "%BUILT%\Nyx.exe" (
  echo.
  echo   [x] 打包好像成功了，但没找到 %BUILT%\Nyx.exe
  echo       把这句话发给 Claude Code。
  echo.
  pause
  exit /b 1
)

rem ── 4 · 替换，但绕开 data 和 dicts ──────────────────────────────
echo   [3/4] 正在替换…
if not exist "%TARGET%" mkdir "%TARGET%"

rem /XD 排除的两个目录：data 是学习数据，dicts 是词典。
rem 它们只存在于 TARGET，源里没有 —— 不排除的话 /MIR 会把它们当成"多余的"删掉。
robocopy "%BUILT%" "%TARGET%" /MIR /XD "%TARGET%\data" "%TARGET%\dicts" /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (
  echo.
  echo   [x] 替换失败。多半是 Nyx 还开着，或者 %TARGET% 不让写。
  echo       把 Nyx 关干净再试一次；还不行就把这句话发给 Claude Code。
  echo.
  pause
  exit /b 1
)

echo   [4/4] 好了。
echo.
echo   现在双击 %TARGET%\Nyx.exe 就是新版本。
echo   你的数据在 %TARGET%\data，一个字节都没动。
echo.
pause