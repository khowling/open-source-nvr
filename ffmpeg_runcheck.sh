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
    echo "$(date): ERROR: Missing arguments" >>/tmp/ffmpeg_runcheck.crontab
    exit 1
fi

#

# Currently active (running)
systemctl is-active  ffmpeg_${camera_name}.service
if [ "$?" -ne 0 ]; then 
    #  Its not running!
    systemctl is-failed   ffmpeg_${camera_name}.service
    if [ "$?" -ne 0 ]; then 
        # Its not failed
        echo "$(date): ffmpeg_${camera_name}.service is not active & not failed, just exit" >>/tmp/ffmpeg_runcheck.crontab
        exit 0
    fi
fi

# The system things the process is runing, or its failed, ensure we have output in the last 30seconds, or restart

if [ ! -f ${filepath}/${camera_name}/stream.m3u8 ] || [ $(($(date +%s) - $(stat -c %Y -- ${filepath}/${camera_name}/stream.m3u8))) -gt 30 ]; then
    echo "$(date): No output for over 30seconds, RESTARTING ffmpeg_${camera_name}.service..." >>/tmp/ffmpeg_runcheck.crontab
    systemctl restart  ffmpeg_${camera_name}.service
fi