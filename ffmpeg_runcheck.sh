#!/bin/bash
# ffmpeg hangs if the camera is rebooted, so check is the file hasnt been written to for 30 seconds, restart the service
# Add to crontab to check every minute
#
#   * * * * * /bin/bash /home/xxxx/ip-camera-manager/ffmpeg_runcheck.sh -n xxx -f /xxx


while getopts n:i:p:f: flag
do
    case "${flag}" in
        n) export camera_name=${OPTARG};;
        f) export filepath=${OPTARG};;
    esac
done

if [ -z "${camera_name}" ] || [ -z "${filepath}" ]; then
    echo "Missing arguments"
    exit 1
fi


if [ $(($(date +%s) - $(stat -c %Y -- ${filepath}/${camera_name}/stream.m3u8))) -gt 30 ]; then
    echo "Restaring ffmpeg for ${camera_name}"
    systemctl restart  ffmpeg_${camera_name}.service
else
    echo "ffmpeg ${camera_name} running ok"
fi