#!/bin/bash

echo ""
echo "========================================"
echo "YT Downloader - Автоматическая сборка"
echo "========================================"
echo ""

echo "[1/3] Установка зависимостей..."
npm install
if [ $? -ne 0 ]; then
    echo "ОШИБКА: Не удалось установить зависимости"
    exit 1
fi

echo ""
echo "[2/3] Сборка приложения..."
npm run build:win
if [ $? -ne 0 ]; then
    echo "ОШИБКА: Не удалось собрать приложение"
    exit 1
fi

echo ""
echo "[3/3] Готово!"
echo ""
echo "Файлы находятся в папке: release/"
echo ""
