#!/bin/bash
while getopts n:i:p:f: flag
do
    case "${flag}" in
        n) export camera_name=${OPTARG};;
        i) export camera_ip=${OPTARG};;
        p) export camera_password=${OPTARG};;
        f) export filepath=${OPTARG};;
    esac
done

if [ -z "${camera_name}" ] || [ -z "${camera_ip}" ] || [ -z "${camera_password}" ] || [ -z "${filepath}" ]; then
    echo "Missing arguments"
    exit 1
fi

echo "Starting streaming for camera ${camera_name}.."
mkdir -p ${filepath}/${camera_name}

TOKEN=$(curl -X POST -d "[{\"cmd\":\"Login\",\"action\":0,\"param\":{\"User\":{\"userName\":\"admin\",\"password\":\"${camera_password}\"}}}]" "http://${camera_ip}/cgi-bin/api.cgi?cmd=Login&token=null" \
  | grep \"name\" | sed -E 's/.*"name" : "?([^,"]*)"?.*/\1/')
  
export TOKEN
ffmpeg -r 25 -i "rtmp://admin:${camera_password}@${camera_ip}/bcs/channel0_main.bcs?token=${TOKEN}&channel=0&stream=0" \
  -hide_banner -loglevel error \
  -vcodec copy \
  -start_number $(echo "$(date +%s) - 1600000000" | bc) \
  ${filepath}/${camera_name}/stream.m3u8