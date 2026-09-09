@echo off
shift /1
node "%~dp0codexCollabMockPeer.mjs" %1 %2 %3 %4 %5 %6 %7 %8 %9
exit /b %ERRORLEVEL%
