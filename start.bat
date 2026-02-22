@echo off
title USMLE QBank Server
echo ============================================
echo    USMLE Step 1 Question Bank
echo    Starting local server...
echo ============================================
echo.
echo Opening browser at http://localhost:8080
echo Press Ctrl+C to stop the server.
echo.
start http://localhost:8080
python -m http.server 8080
