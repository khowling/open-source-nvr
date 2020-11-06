//import logo from './logo.svg';
//import './App.css';
import React, { useCallback, useRef, useEffect } from 'react';
import videojs from 'video.js'
import { Fabric, DetailsList, SelectionMode, Stack } from '@fluentui/react'

function App() {

  const [moments, setMoments] = React.useState([])


  const video_ref = useCallback(node => {
    if (node !== null) {
      let mPlayer = videojs(node, {
        autoplay: true,
        controls: true//,
        // sources: [{
        //   src: '/video/mp4/out-test-2020-11-05_18-30-30.mp4',
        //   type: 'video/mp4'
        //  }]
      }, function onPlayerReady() {
        console.log('onPlayerReady', this)
      })
    }
  })

  /*
  const video_ref = useRef(null);
  useEffect(() => {
    //let mPlayer = videojs(node, {
    let mPlayer = videojs(video_ref.current, {
      autoplay: true,
      controls: true//,
      // sources: [{
      //   src: '/video/mp4/out-test-2020-11-05_18-30-30.mp4',
      //   type: 'video/mp4'
      //  }]
    }, function onPlayerReady() {
      console.log('onPlayerReady', this)
    })

    return () => {
      mPlayer.dispose()
    }

  }, []);
*/

  useEffect(() => {
    fetch("/api/movements")
      .then(res => res.json())
      .then(
        (result) => {
          setMoments(result);
        },
        // Note: it's important to handle errors here
        // instead of a catch() block so that we don't swallow
        // exceptions from actual bugs in components.
        (error) => {
          console.warn(error)
        }
      )
  }, [])

  function _onItemInvoked(e) {
    mPlayer.src({ type: "video/mp4", src: `/video/mp4/${e.file}` })
    mPlayer.currentTime(e.index)
    console.log(e)
  }


  return (
    <Fabric>
      <main id="mainContent" data-grid="container">
        <Stack horizontal wrap tokens={{ childrenGap: 15 }}>
          <Stack.Item styles={{ root: { width: "300px" } }} grow={1}>
            <DetailsList
              items={moments}
              compact={true}
              columns={[
                { name: "Start", key: "start", fieldName: "start" },
                { name: "Duration (secs)", key: "duration", fieldName: "duration" },
                { name: "File", key: "file", fieldName: "file" }
              ]}
              selectionMode={SelectionMode.none}
              setKey="none"
              isHeaderVisible={true}
              onItemInvoked={_onItemInvoked}
            />
          </Stack.Item>
          <Stack.Item styles={{ root: { width: "700px" } }} grow={1}>
            <div data-vjs-player>
              <video ref={video_ref} className="video-js vjs-default-skin" width="640" height="268" />
            </div>
          </Stack.Item>
        </Stack>
      </main>
    </Fabric >
  );
}

export default App;
