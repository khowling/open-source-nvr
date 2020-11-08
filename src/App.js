//import logo from './logo.svg';
//import './App.css';
import React, { /* useCallback , */ useRef, useEffect } from 'react';
import videojs from 'video.js'
import { Fabric, PrimaryButton, DetailsList, SelectionMode, Selection, Stack, Checkbox } from '@fluentui/react'
import { initializeIcons } from '@fluentui/react/lib/Icons';

initializeIcons(/* optional base url */);

function App() {

  const [moments, setMoments] = React.useState([])
  const [state, setState] = React.useState({ current_idx: null, inputs: {} })

  /*
    const video_ref = useCallback(node => {
      if (node !== null) {
        videojs(node, {
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
    }, [])
  */

  const video_ref = useRef(null);
  useEffect(() => {
    console.log(`initialising videojs on ${video_ref.current}`)
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

  }, [video_ref]);


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

  function _onItemInvoked(e, idx) {
    if (idx !== state.current_idx && e.video) {
      setState({ current_idx: idx, inputs: { ...state.inputs, [idx]: { reviewed: true } } })
      //setMoments([...moments.slice(0, idx), { ...moments[idx], reviewed: true }, ...moments.slice(idx + 1)])
      let mPlayer = videojs(video_ref.current)
      if (mPlayer.src() !== `/video/${e.video.file}`) {
        mPlayer.src({ type: "video/mp4", src: `/video/${e.video.file}` })
      }
      mPlayer.currentTime(Math.max(0, e.video.index - 4)) // 4 seconds before moments
      mPlayer.play()
      //console.log(mPlayer.remainingTime())
      //if (mPlayer.remainingTime() < e.duration + 4) {
      //  alert('movement goes onto the next file')
      //}
      console.log(e)
    }
  }

  function process() {
    const body = JSON.stringify(Object.keys(state.inputs).map((i) => { return { ...moments[i], ...state.inputs[i] } }))

    fetch('/api/movements', {
      body,
      method: "POST",
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
      }
    }).then(async (res) => {
      if (!res.ok) {
        console.error(`non 200 err : ${res.status}`)
      } else if (res.status === 201) {
        window.location.reload(true)
      } else {
        console.error(`non 200 err : ${res.status}`)
      }
    }, err => {
      console.error(`err : ${err}`)
    })
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
                {
                  name: "Reviewed Movement (seconds)", key: "start", minWidth: 200, maxWidth: 200, onRender: (i, idx) => {
                    return <Checkbox label={`${i.start} (${i.duration})`} checked={state.inputs[idx] && state.inputs[idx].reviewed} disabled />
                  }
                },
                {
                  name: "Save", key: "stat", onRender: (i, idx) => {
                    return <div> <Checkbox checked={state.inputs[idx] && state.inputs[idx].save} onChange={(e, val) => setState({ current_idx: idx, inputs: { ...state.inputs, [idx]: { reviewed: true, save: val } } })} /> </div>
                  }
                }
              ]}
              selectionMode={SelectionMode.single}
              isHeaderVisible={true}
              onActiveItemChanged={_onItemInvoked}
            />
            <PrimaryButton text="Update" onClick={process} />
          </Stack.Item>

          <Stack.Item styles={{ root: { width: "700px" } }} grow={1}>
            <div >
              <video ref={video_ref} className="video-js vjs-default-skin" width="640" height="268" />
            </div>
          </Stack.Item>
        </Stack>
      </main>
    </Fabric >
  );
}

export default App;
