//import logo from './logo.svg';
import './App.css';
import React, { /* useCallback , */ useRef, useEffect } from 'react';
import videojs from 'video.js'
import { Text, Toggle, DefaultButton, DetailsList, SelectionMode, Stack, Checkbox, Selection, PrimaryButton } from '@fluentui/react'
import { initializeIcons } from '@fluentui/react/lib/Icons';

initializeIcons(/* optional base url */);

function App() {

  //const [movements, setMovements] = React.useState([])
  //const [cameras, setCameras] = React.useState([])
  const [data, setData] = React.useState({ cameras: [], movements: [] })
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
        if (data.cameras.length > 0) {
          playVideo(data.cameras[0])
        }

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

  function getServerData() {

    fetch(`/api/movements`)
      .then(res => res.json())
      .then(
        (result) => {
          setData(result)
        },
        // Note: it's important to handle errors here
        // instead of a catch() block so that we don't swallow
        // exceptions from actual bugs in components.
        (error) => {
          console.warn(error)
        }
      )
  }
  useEffect(getServerData, [])



  function _onItemInvoked(m, idx) {
    setInputState({ ...inputState, inputs: { ...inputState.inputs, [m.key]: { reviewed: false } } })
  }

  function _itemChanged(m, idx) {
    // (_section.isAllSelected ${_selection.isAllSelected()})
    console.log(`_itemChanged ${idx} (old ${inputState.current_idx})  (allSelected ${inputState.allSelected})`)
    if (idx !== inputState.current_idx) {
      setInputState({ current_idx: idx, current_movement: m, allSelected: inputState.allSelected, inputs: { ...inputState.inputs, [m.key]: { reviewed: true } } })
    }
    if (playerReady) {
      playVideo(data.cameras.find(c => c.name === m.movement.cameraName), m.key)
    }
  }

  function playVideo(camera, movementKey) {
    if (video_ref.current) {
      let mPlayer = videojs(video_ref.current)

      mPlayer.src({
        src: `/video/${movementKey || camera.name}/stream.m3u8${movementKey ? `?preseq=${camera.segments_prior_to_movement}&postseq=${camera.segments_post_movement}` : ''}`,
        type: 'application/x-mpegURL'
      })
      if (movementKey) {
        mPlayer.currentTime(camera.segments_prior_to_movement * 2) // 20 seconds into stream (coresponds with 'segments_prior_to_movement')
      }
      mPlayer.play()
    }
  }

  function reloadlist() {
    setInputState({ current_idx: 'none', allSelected: inputState.allSelected, inputs: {} })
    getServerData()
  }

  const _selection = new Selection({
    //isAllSelected: (e) => {
    onSelectionChanged: function () {
      console.log(`onSelectionChanged ${_selection.isAllSelected()}, current idx ${inputState.current_idx}`)
      //setInputState({ ...inputState, allSelected: _selection.isAllSelected() })

    }
  })



  function recordReview() {
    console.log(inputState.current_movement)
    if (playerReady && inputState.current_movement) {
      let mPlayer = videojs(video_ref.current)
      console.log(mPlayer.currentTime())
      const c = data.cameras.find(c => c.name === inputState.current_movement.movement.cameraName)
      window.open(`/mp4/${inputState.current_movement.key}${c ? `?preseq=${c.segments_prior_to_movement}&postseq=${c.segments_post_movement}` : ''}`, '_blank').focus()
    }

  }
  /*
  const body = JSON.stringify(Object.keys(inputState.inputs).filter(i => inputState.inputs[i].reviewed).map((i) => { return { movement_key: i } }))

  fetch(`/ api / movements / ${ process.env.REACT_APP_CAMERA_NAME }`, {
    body,
    method: "POST",
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body)
    }
  }).then(async (res) => {
    if (!res.ok) {
      console.error(`non 200 err : ${ res.status }`)
    } else if (res.status === 201) {
      //window.location.reload(true)
      getMovements()
      setInputState({ current_idx: 'none', allSelected: false, inputs: {} })
    } else {
      console.error(`non 200 err : ${ res.status }`)
    }
  }, err => {
    console.error(`err : ${ err }`)
  })

}
  */
  function filterIgnoreTags(event) {
    const { movement } = event
    if (movement && movement.ml && movement.ml.success && Array.isArray(movement.ml.tags) && movement.ml.tags.length > 0) {
      const { ignore_tags } = data.cameras.find(c => c.name === movement.cameraName) || {}
      if (ignore_tags && Array.isArray(ignore_tags) && ignore_tags.length > 0) {
        return movement.ml.tags.reduce((a, c) => ignore_tags.includes(c.tag) ? a : a.concat(c), [])
      } else {
        return movement.ml.tags
      }
    }
    return []
  }

  function renderTags(event, idx) {

    const { key, movement } = event
    const img = `/image/${key}`

    if (movement.ml) {
      if (movement.ml.success) {
        const filteredTags = filterIgnoreTags(event)
        if (filteredTags.length > 0) {
          return filteredTags.map((t, idx) => <div><a key={idx} target="_blank" href={img}><Text variant="mediumPlus" >{t.tag} ({t.probability}); </Text></a></div>)
        } else {
          return <a key={idx} target="_blank" href={img}><Text variant="mediumPlus" >ML Image</Text></a>
        }
      } else {
        return <Text variant="mediumPlus">ML error: {movement.ml.stderr}</Text>
      }
    } else if (movement.ffmpeg) {
      if (movement.ffmpeg.success) {
        return <a key={idx} target="_blank" href={img}><Text variant="mediumPlus">Image (wait for ML)</Text></a>
      } else {
        return <Text variant="mediumPlus">Error: {movement.ffmpeg.stderr}</Text>
      }
    } else {
      return <Text variant="mediumPlus">please wait..</Text>
    }
  }

  function playLive(arg1, item) {
    if (playerReady) {
      if (item) {
        console.log(`playing ${item.key}`)
        playVideo(data.cameras.find(c => c.name === item.key))
      } else if (data.cameras.length > 0) {
        console.log('playing default')
        playVideo(data.cameras[0])
      }
    } else {
      alert("Player not ready")
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
            <PrimaryButton styles={{ root: { minWidth: '50px' } }} onClick={recordReview} >Export</PrimaryButton>
            <DefaultButton styles={{ root: { minWidth: '50px' } }} onClick={reloadlist} >Refresh</DefaultButton>
            <DefaultButton split menuProps={{ items: data.cameras.map(c => { return { key: c.name, text: c.name, onClick: playLive } }) }}  >Live</DefaultButton>
          </Stack>
          <DetailsList
            isHeaderVisible={false}
            items={taggedOnly ? data.movements.filter(m => filterIgnoreTags(m).length > 0) : data.movements}
            compact={true}
            //listProps={state}
            columns={[
              {
                name: "Reviewed Movement (seconds)", key: "start", minWidth: 200, ...(showPlayer && { maxWidth: 200 }), onRender: (m, idx) =>
                  <div>
                    <Text key={idx + 1} variant="mediumPlus">{m.startDateGb} ({m.movement.seconds}s {m.movement.cameraName})</Text>
                    {!showPlayer && <div key={idx + 2}><img src={`/image/${m.key}`} style={{ maxWidth: "100%" }} /></div>}
                  </div>


              }
            ].concat(showPlayer ? {
              name: "Save", key: "stat", minWidth: 80, maxWidth: 80, onRender: renderTags
            } : [])
            }
            selectionMode={SelectionMode.single}
            onActiveItemChanged={_itemChanged}
            onItemInvoked={_onItemInvoked}
          />

        </Stack.Item>


      </Stack>
    </main >
  );
}

export default App;
