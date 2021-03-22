//import logo from './logo.svg';
import './App.css';
import React, { /* useCallback , */ useRef, useEffect } from 'react';
import videojs from 'video.js'
import { Toggle, DefaultButton, DetailsList, SelectionMode, Stack, Checkbox, Selection, PrimaryButton } from '@fluentui/react'
import { initializeIcons } from '@fluentui/react/lib/Icons';

initializeIcons(/* optional base url */);

function App() {

  const [video_mode] = React.useState(window.location.pathname === '/' ? "" : window.location.pathname)
  const [moments, setMoments] = React.useState([{
    "startDate": "Live",
    "movement_key": "live",
    "seconds": "0"
  }])
  const [inputState, setInputState] = React.useState({ current_idx: 0, allSelected: false, inputs: {} })
  const [imageReview, setImageReview] = React.useState(false)
  const [playerReady, setPlayerReady] = React.useState(false)

  const video_ref = useRef(null)
  useEffect(() => {
    console.log(`initialising videojs on ${video_ref.current}`)
    let mPlayer = videojs(video_ref.current, {
      autoplay: true,
      controls: true,
      aspectRatio: '4:3',
      liveui: true,
      sources: [{
        src: `/video/${process.env.REACT_APP_CAMERA_NAME}/live/stream.m3u8`,
        type: 'application/x-mpegURL'
      }]
    }, () => {
      console.log('player ready')
      setPlayerReady(true)
    })

    return () => {
      setPlayerReady(false)
      if (mPlayer) mPlayer.dispose()
    }

  }, [video_ref])

  function getMovements() {

    fetch(`/api/movements/${process.env.REACT_APP_CAMERA_NAME}`)
      .then(res => res.json())
      .then(
        (result) => {
          setMoments([{
            "startDate": "Live",
            "movement_key": "live",
            "seconds": "0"
          }, ...result]);
        },
        // Note: it's important to handle errors here
        // instead of a catch() block so that we don't swallow
        // exceptions from actual bugs in components.
        (error) => {
          console.warn(error)
        }
      )
  }
  useEffect(getMovements, [])



  function _onItemInvoked(e, idx) {
    if (idx > 0) { // 0 is live
      setInputState({ ...inputState, inputs: { ...inputState.inputs, [idx]: { reviewed: false } } })
    }
  }

  function _itemChanged(e, idx) {
    // (_section.isAllSelected ${_selection.isAllSelected()})
    console.log(`_onItemInvoked ${idx} (old ${inputState.current_idx})  (allSelected ${inputState.allSelected})`)
    if (idx !== inputState.current_idx) {

      //let video = e.video
      //if (video_mode !== '/video_only') {
      setInputState({ current_idx: idx, allSelected: inputState.allSelected, inputs: idx > 0 ? { ...inputState.inputs, [idx]: { reviewed: true } } : inputState.inputs })
      //} else {
      //  video = e
      //}

      console.log(e)
      if (playerReady) {
        let mPlayer = videojs(video_ref.current)
        //if (mPlayer.src() !== `/video/${video.file}`) {
        mPlayer.src({
          src: `/video/${process.env.REACT_APP_CAMERA_NAME}/${e.movement_key}/stream.m3u8`,
          type: 'application/x-mpegURL'
        })
        //}
        //mPlayer.currentTime(Math.max(0, video.index - 4)) // 4 seconds before moments
        mPlayer.play()
      }
    }
  }

  function reset() {
    setInputState({ current_idx: 0, allSelected: inputState.allSelected, inputs: {} })
    getMovements()
  }

  const _selection = new Selection({
    //isAllSelected: (e) => {
    onSelectionChanged: function () {
      console.log(`onSelectionChanged ${_selection.isAllSelected()}, current idx ${inputState.current_idx}`)
      //setInputState({ ...inputState, allSelected: _selection.isAllSelected() })

    }
  })



  function recordReview() {
    const body = JSON.stringify(Object.keys(inputState.inputs).map((i) => { return { ...moments[i], ...inputState.inputs[i] } }))

    fetch(`/api/movements/${process.env.REACT_APP_CAMERA_NAME}`, {
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
        //window.location.reload(true)
        getMovements()
        setInputState({ current_idx: null, allSelected: false, inputs: {} })
      } else {
        console.error(`non 200 err : ${res.status}`)
      }
    }, err => {
      console.error(`err : ${err}`)
    })
  }


  return (
    <main id="mainContent" data-grid="container">

      <nav className="header">
        <div className="logo">Home Surveillance Recordings</div>
        <input className="menu-btn" type="checkbox" id="menu-btn" />
        <label className="menu-icon" htmlFor="menu-btn"><span className="navicon"></span></label>
        <ul className="menu">
          <li><a href="/">Recorded Movements</a></li>
          <li><a href="/video_only">Recorded Video</a></li>
          <li><a href="/live">Live Feed</a></li>
          <li><a href="/metrics">Network Metrics</a></li>
          <li><a href="/network">Network Control</a></li>
        </ul>
      </nav>

      <div style={{ "height": "43px", "width": "100%" }} />

      <Stack horizontal wrap >

        <Stack.Item styles={imageReview ? {} : { root: { width: "700px" } }} grow={1}>
          <video ref={video_ref} className="video-js vjs-default-skin" width="640" height="268" />
          <div>{inputState.current_idx !== null && moments[inputState.current_idx].video ? `${moments[inputState.current_idx].video.file} (${moments[inputState.current_idx].video.index})` : ""}</div>

        </Stack.Item>


        <Stack.Item styles={imageReview ? {} : { root: { width: "300px" } }} grow={1}>
          <Stack horizontal>
            <Toggle inlineLabel onText="Image Review" offText="Video Review" styles={{ root: { "marginTop": "5px" } }} onChange={(e, val) => {
              if (val) {
                setPlayerReady(false)
                videojs(video_ref.current).dispose()
                console.log('player dispose')
              } else {
                videojs(video_ref.current, {
                  autoplay: true,
                  controls: true,
                  aspectRatio: '4:3',
                  liveui: true,
                  sources: [{
                    src: `/video/${process.env.REACT_APP_CAMERA_NAME}/live/stream.m3u8`,
                    type: 'application/x-mpegURL'
                  }]
                }, () => {
                  console.log('player ready')
                  setPlayerReady(true)
                })
              }
              setImageReview(val)
            }} />
            <PrimaryButton onClick={recordReview} >Record Reviews</PrimaryButton>
            <DefaultButton onClick={reset} >Reset</DefaultButton>
          </Stack>
          <DetailsList
            isHeaderVisible={false}
            items={moments}
            compact={true}
            //listProps={state}
            columns={video_mode === '/video_only' ? [
              { name: "Video file", key: "file", fieldName: "file" }
            ]
              :
              [
                {
                  name: "Reviewed Movement (seconds)", key: "start", minWidth: 200, maxWidth: 200, onRender: (i, idx) => {
                    //console.log(`rendering ${idx} - input ${state.inputs[idx]}`)
                    if (i.startDate === 'Live') {
                      return <div>Live</div>
                    } else {
                      return <Checkbox label={`${i.startDate} (${i.seconds})`} checked={inputState.allSelected ? true : (inputState.inputs[idx] ? inputState.inputs[idx].reviewed : false)} disabled />
                    }
                  }
                },
                {
                  name: "Save", key: "stat", minWidth: 80, maxWidth: 80, onRender: (i, idx) => {
                    if (i.startDate === 'Live') {
                      return <div></div>
                    } else {
                      const status = i.ml ? (i.ml.success ? i.ml.tags.map(t => <div>tag: {t.tag} - {t.probability}</div>) : <div>ml error: {i.ml.stderr}</div>) : (i.ffmpeg ? (i.ffmpeg.success ? <div>ffmpeg success</div> : <div>ffmpeg error: {i.ffmpeg.stderr}</div>) : <div>please wait..</div>)
                      const img = `/image/${process.env.REACT_APP_CAMERA_NAME}/${i.movement_key}`
                      if (imageReview) {
                        return <div>
                          {status}
                          <img width="600" src={img}></img>
                        </div>

                      } else {
                        return <div>
                          {status}
                          <a target="_blank" href={img}>image</a>
                        </div>
                      }
                    }
                    /*
                    if (i.video) {
                      return <Checkbox checked={inputState.inputs[idx] ? inputState.inputs[idx].save : false} onChange={(e, val) => {
                        console.log('check')
                        setInputState({ current_idx: idx, allSelected: inputState.allSelected, inputs: { ...inputState.inputs, [idx]: { reviewed: true, save: val } } })
 
                      }} label={`${i.video.file} (${i.video.index})`} />
                    } else {
                      return <div>no video</div>
                    }
                    */
                  }
                }
              ]}
            selectionMode={SelectionMode.multiple}
            //selection={_selection}

            onActiveItemChanged={_itemChanged}
            onItemInvoked={_onItemInvoked}
          />

        </Stack.Item>


      </Stack>
    </main>
  );
}

export default App;
