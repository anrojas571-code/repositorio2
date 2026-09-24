@echo off
chcp 65001 >nul
title Configurar Nombre del Sistema (sistema.local)

echo ======================================================================
echo    CONFIGURAR NOMBRE DEL SISTEMA LOCAL: sistema.local
echo ======================================================================
echo.

:: Verificar permisos de Administrador
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [!] Este script requiere permisos de Administrador para modificar el
    echo     archivo hosts de Windows (C:\Windows\System32\drivers\etc\hosts).
    echo.
    echo Por favor:
    echo  1. Haz clic derecho sobre este archivo 'activar-nombre-sistema.bat'
    echo  2. Selecciona "Ejecutar como administrador"
    echo.
    pause
    exit /b 1
)

set HOSTS_FILE=%SystemRoot%\System32\drivers\etc\hosts

:: Verificar si ya está configurado
findstr /i "sistema.local" "%HOSTS_FILE%" >nul
if %errorLevel% equ 0 (
    echo [OK] El nombre 'sistema.local' ya esta configurado en tu equipo.
) else (
    echo Agregando 'sistema.local' y 'sistema-usuarios.local' al archivo hosts...
    echo. >> "%HOSTS_FILE%"
    echo # Sistema de Gestion de Usuarios >> "%HOSTS_FILE%"
    echo 127.0.0.1    sistema.local >> "%HOSTS_FILE%"
    echo 127.0.0.1    sistema-usuarios.local >> "%HOSTS_FILE%"
    echo [EXITO] Nombres agregados correctamente.
)

:: Vaciar cache DNS
ipconfig /flushdns >nul
echo.
echo ======================================================================
echo  TODO LISTO: Ahora puedes ingresar desde cualquier navegador a:
echo    -> http://sistema.local:3000
echo    -> http://sistema.local:3000/admin
echo ======================================================================
echo.
pause
