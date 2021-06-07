//import logo from './logo.svg';
import './App.css';
import React, { /* useCallback , */ useRef, useEffect } from 'react';
import videojs from 'video.js'
import { Toggle, DefaultButton, DetailsList, SelectionMode, Stack, Checkbox, Selection, PrimaryButton } from '@fluentui/react'
import { initializeIcons } from '@fluentui/react/lib/Icons';

initializeIcons(/* optional base url */);

function App() {

  //const [video_mode] = React.useState(window.location.pathname === '/' ? "" : window.location.pathname)
  const [moments, setMoments] = React.useState([])
  const [inputState, setInputState] = React.useState({ current_idx: 'none', allSelected: false, inputs: {} })
  const [taggedOnly, setTaggedOnly] = React.useState(true)
  const [showPlayer, setShowPlayer] = React.useState(true)
  const [playerReady, setPlayerReady] = React.useState(false)

  let video_ref = useRef(null)
  useEffect(() => {
    if (showPlayer) {
      console.log(`useEffect: initialising videojs on ${video_ref.current}`)
      let mPlayer = videojs(video_ref.current, {
        autoplay: true,
        controls: true,
        aspectRatio: '4:3',
        liveui: true
      }, () => {
        console.log('player ready')
        setPlayerReady(true)
        playVideo()

      })

      return () => {
        console.log(`useEffect: dispose return`)
        setPlayerReady(false)
        if (mPlayer) mPlayer.dispose()
      }
    } else {
      console.log(`useEffect: disposing videojs on ${video_ref.current}`)
      setPlayerReady(false)
      if (video_ref.current) {
        videojs(video_ref.current).dispose()
      }
    }
  }, [video_ref, showPlayer])

  function getMovements() {

    fetch(`/api/movements/${process.env.REACT_APP_CAMERA_NAME}`)
      .then(res => res.json())
      .then(
        (result) => {
          setMoments(result)
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



  function _onItemInvoked(m, idx) {
    setInputState({ ...inputState, inputs: { ...inputState.inputs, [m.movement_key]: { reviewed: false } } })
  }

  function _itemChanged(m, idx) {
    // (_section.isAllSelected ${_selection.isAllSelected()})
    console.log(`_itemChanged ${idx} (old ${inputState.current_idx})  (allSelected ${inputState.allSelected})`)
    if (idx !== inputState.current_idx) {
      setInputState({ current_idx: idx, allSelected: inputState.allSelected, inputs: { ...inputState.inputs, [m.movement_key]: { reviewed: true } } })
      if (playerReady) {
        playVideo(m.movement_key)
      }
    }
  }

  function playVideo(movement) {
    if (video_ref.current) {
      let mPlayer = videojs(video_ref.current)

      mPlayer.src({
        src: `/video/${process.env.REACT_APP_CAMERA_NAME}/${movement || 'live'}/stream.m3u8`,
        type: 'application/x-mpegURL'
      })
      if (movement) {
        mPlayer.currentTime(18) // 20 seconds into stream (coresponds with 'segments_prior_to_movement')
      }
      mPlayer.play()
    }
  }

  function reloadlist() {
    setInputState({ current_idx: 'none', allSelected: inputState.allSelected, inputs: {} })
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
    const body = JSON.stringify(Object.keys(inputState.inputs).filter(i => inputState.inputs[i].reviewed).map((i) => { return { movement_key: i } }))

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
        setInputState({ current_idx: 'none', allSelected: false, inputs: {} })
      } else {
        console.error(`non 200 err : ${res.status}`)
      }
    }, err => {
      console.error(`err : ${err}`)
    })
  }

  function renderImage(m, idx) {
    const status = m.ml ? ((m.ml.success && Array.isArray(m.ml.tags)) ? m.ml.tags.filter(t => t.tag !== 'car').map(t => <div>{t.tag} ({t.probability})</div>) : <div>ml error: {m.ml.stderr}</div>) : (m.ffmpeg ? (m.ffmpeg.success ? <div>ffmpeg success</div> : <div>ffmpeg error: {m.ffmpeg.stderr}</div>) : <div>please wait..</div>)
    const img = `/image/${process.env.REACT_APP_CAMERA_NAME}/${m.movement_key}`
    if (showPlayer) {
      return <div>
        {status}
        <a target="_blank" href={img}>image</a>
      </div>
    } else {
      return <div>
        {status}
        <img src={img} style={{ maxWidth: "100%" }} />
      </div>
    }
  }


  return (
    <main id="mainContent" data-grid="container">

      <nav className="header">
        <div className="logo">Home Surveillance</div>
        <input className="menu-btn" type="checkbox" id="menu-btn" />
        <label className="menu-icon" htmlFor="menu-btn"><span className="navicon"></span></label>
        <ul className="menu">
          <li><a href="/grafana/?orgId=1">Grafana</a></li>
          <li><a href="/network">Network Control</a></li>
        </ul>
      </nav>

      <div style={{ "height": "43px", "width": "100%" }} />

      <Stack horizontal wrap >
        {showPlayer &&
          <Stack.Item styles={{ root: { width: "700px" } }} grow={1}>
            <video ref={video_ref} className="video-js vjs-default-skin" width="640" height="268" />
          </Stack.Item>
        }

        <Stack.Item styles={showPlayer ? { root: { width: "300px" } } : {}} grow={1}>
          <Stack horizontal>
            <Toggle inlineLabel onText="Tag'd" offText="All" styles={{ root: { "marginTop": "5px" } }} onChange={(e, val) => setTaggedOnly(val)} checked={taggedOnly} />
            <Toggle inlineLabel onText="Video" offText="Image" styles={{ root: { "marginTop": "5px" } }} onChange={(e, val) => setShowPlayer(val)} checked={showPlayer} />
            <PrimaryButton styles={{ root: { minWidth: '50px' } }} onClick={recordReview} >Save</PrimaryButton>
            <DefaultButton styles={{ root: { minWidth: '50px' } }} onClick={reloadlist} >Load</DefaultButton>
            <DefaultButton styles={{ root: { minWidth: '50px' } }} onClick={() => playerReady && playVideo()} >Live</DefaultButton>
          </Stack>
          <DetailsList
            isHeaderVisible={false}
            items={taggedOnly ? moments.filter(m => m.ml && m.ml.success && Array.isArray(m.ml.tags) && m.ml.tags.filter(t => t.tag !== 'car').length > 0) : moments}
            compact={true}
            //listProps={state}
            columns={[
              {
                name: "Reviewed Movement (seconds)", key: "start", minWidth: 200, ...(showPlayer && { maxWidth: 200 }), onRender: (m, idx) => [
                  //console.log(`rendering ${idx} - input ${state.inputs[idx]}`)
                  <div>
                    <Checkbox label={`${m.startDate} (${m.seconds})`} checked={inputState.allSelected ? true : (inputState.inputs[m.movement_key] ? inputState.inputs[m.movement_key].reviewed : false)} disabled />
                    {!showPlayer && renderImage(m, idx)}
                  </div>
                ]
              }
            ].concat(showPlayer ? {
              name: "Save", key: "stat", minWidth: 80, maxWidth: 80, onRender: renderImage
            } : [])
            }
            selectionMode={SelectionMode.multiple}
            onActiveItemChanged={_itemChanged}
            onItemInvoked={_onItemInvoked}
          />

        </Stack.Item>


      </Stack>
    </main>
  );
}

export default App;
