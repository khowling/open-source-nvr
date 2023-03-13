//import logo from './logo.svg';
import './App.css';
import React, { useEffect }  from 'react';
import videojs from 'video.js'
import { ThemeProvider, CommandBar, Text, DetailsList, Stack, Selection, SelectionMode } from '@fluentui/react'
import { initializeIcons } from '@fluentui/react/lib/Icons';
import { createTheme } from '@fluentui/react';
import { PanelSettings } from './PanelSettings.js'

const appTheme = createTheme({
  defaultFontStyle: { fontWeight: 'regular' },
  fonts: {
    small: {
      fontSize: '14px',
    },
    medium: {
      fontSize: '16px',
    },
    large: {
      fontSize: '16px',
      fontWeight: 'semibold',
    },
    xLarge: {
      fontSize: '18px',
      fontWeight: 'semibold',
    },
  },
});

initializeIcons(/* optional base url */);

function VideoJS (props)  {

  const videoRef = React.useRef(null);
  const playerRef = React.useRef(null);
  const { options, onReady } = props;

  React.useEffect(() => {
    // make sure Video.js player is only initialized once
    if (!playerRef.current) {
      const videoElement = videoRef.current;
      if (!videoElement) return;

      const player = playerRef.current = videojs(videoElement, options, () => {
        console.log("player is ready");
        onReady && onReady(player);
      });
    } else {
      // you can update player here [update player through props]
      // const player = playerRef.current;
      // player.autoplay(options.autoplay);
      // player.src(options.sources);
    }
  }, [options, videoRef]);

  // Dispose the Video.js player when the functional component unmounts
  React.useEffect(() => {
    const player = playerRef.current;

    return () => {
      if (player) {
        player.dispose();
        playerRef.current = null;
      }
    };
  }, [playerRef]);

  return (
    <div data-vjs-player>
      <video ref={videoRef} className="video-js vjs-big-play-centered" />
    </div>
  );
}


function App() {

  const [panel, setPanel] = React.useState({open: false, invalidArray: []});

  //const [invalidArray, setInvalidArray] = React.useState([])

  const init_data = { cameras: [], movements: [] }
  const [data, setData] = React.useState(init_data)
  const [currentPlaying, setCurrentPlaying] = React.useState(null)
  //const [inputState, setInputState] = React.useState({ current_idx: 'none', allSelected: false, inputs: {} })
  const [mode, setMode] = React.useState('Filtered')
  const [showPlayer, setShowPlayer] = React.useState(true)
  //const [playerReady, setPlayerReady] = React.useState(false)



  const playerRef = React.useRef(null);

  console.log ("mode: ", mode)

  const handlePlayerReady = (player) => {
    playerRef.current = player;

    // you can handle player events here
    player.on('waiting', () => {
      console.log('handlePlayerReady: player is waiting');
    });

    player.on('dispose', () => {
      console.log('handlePlayerReady: player will dispose');
    });
  };

  function getServerData() {
    //setCurrentPlaying(null)
    console.log ('getServerData, mode=', mode)
    setData({...init_data, status: 'fetching'})
    fetch(`/api/movements?mode=${mode}`)
      .then(res => res.json())
      .then(
        (result) => {
          setData({...result, status: 'success'})

          console.log (`got refresh, find first streaming enabled camera & play`)
          const streamingCameras = result?.cameras.filter(c => c.enable_streaming)

          if (currentPlaying && streamingCameras.findIndex(c => c.key === currentPlaying.cKey) >= 0 && (!currentPlaying.mKey || result?.movements.findIndex(m => m.key === currentPlaying.mKey) >= 0)) {
            console.log (`we can continue playing same before refresh, because camera and/or movement is still valid`)
          } else {
            if (streamingCameras && streamingCameras.length > 0) {
              playVideo (streamingCameras[0].key)
            }
          }
        },
        // Note: it's important to handle errors here
        // instead of a catch() block so that we don't swallow
        // exceptions from actual bugs in components.
        (error) => {
          setData({...init_data, status: 'error', message: error})
          console.warn(error)
        }
      )
  }

  
  useEffect(getServerData, [mode])

  function playVideo(cKey, mKey, mStartSegment, mSeconds, segments_prior_to_movement, segments_post_movement) {
    console.log (`playVideo mode=${mode} cameraKey=${cKey} mKey=${mKey}`)
    const mPlayer = playerRef.current
    //console.log ("playVideo data: ", data)
    //const camera = cKey && data.cameras.find(c => c.key === cKey)
    if (cKey && mPlayer && (!currentPlaying || (currentPlaying.cKey !== cKey || currentPlaying.mKey !== mKey))) {

      setCurrentPlaying({ cKey, mKey})
      mPlayer.src({
        src: `/video/${mKey ? `${mStartSegment}/${mSeconds}` : 'live' }/${cKey}/stream.m3u8${(mKey && segments_prior_to_movement) ? `?preseq=${segments_prior_to_movement}&postseq=${segments_post_movement}` : ''}`,
        type: 'application/x-mpegURL'
      })

      if (mKey && segments_prior_to_movement) {
        mPlayer.currentTime(segments_prior_to_movement * 2) // 20 seconds into stream (coresponds with 'segments_prior_to_movement')
      }
      mPlayer.play()
    } else {
      console.warn(`playVideo : player not ready or cannot find camera, or already playing selected camera/movement`)
    }
  }

  
  const _selection = new Selection({
    getKey: function (m) { return  m.key },
    onSelectionChanged: function () {
      //console.log (`onSelectionChanged: getSelectedIndices()=${JSON.stringify(_selection.getSelectedIndices())}, getSelection()=${JSON.stringify(_selection.getSelection())}`)
      const selectedItems = _selection.getSelection()
      if (selectedItems.length > 0) {
        const {key, cameraKey, startSegment, seconds, segments_prior_to_movement, segments_post_movement} = selectedItems[0]
        playVideo(cameraKey, key, startSegment, seconds, segments_prior_to_movement, segments_post_movement)
      }
    }
  })

  function _debug(item) {
    console.log (item)
    alert (JSON.stringify(item, null, 4))
  }

  function downloadMovement() {
    if (currentPlaying && currentPlaying.cKey && currentPlaying.mKey) {
      const c = data.cameras.find(c => c.key === currentPlaying.cKey)
      const m = data.movements.find(m => m.key === currentPlaying.mKey)
      window.open(`/mp4/${m.movement.startSegment}/${m.movement.seconds}/${m.movement.cameraKey}${(c && mode !== 'Time') ? `?preseq=${c.segments_prior_to_movement}&postseq=${c.segments_post_movement}` : ''}`, '_blank').focus()
    }
  }

/*
  function filterIgnoreTags(cameraKey, ml) {
    if (ml && ml.success && Array.isArray(ml.tags) && ml.tags.length > 0) {
      const { ignore_tags } = data.cameras.find(c => c.key === cameraKey) || {}
      if (ignore_tags && Array.isArray(ignore_tags) && ignore_tags.length > 0) {
        return ml.tags.reduce((a, c) => ignore_tags.includes(c.tag) ? a : a.concat(c), [])
      } else {
        return ml.tags
      }
    }
    return []
  }
*/
  function renderTags(selectedList, idx) {

    if (false) {
    return <a target="_blank" href="http://www.google.com"><Stack>{[{tag: "tag1", probability: 100},{tag: "tag1", probability: 100}].map((t, idx) => <Text key={idx} variant="mediumPlus" >{t.tag} ({t.probability})</Text>)}</Stack></a>
    }

    const { key, cameraKey, ml, ffmpeg} = selectedList
    const img = `/image/${key}`

    if (ml) {
      if (ml.success) {
        //const filteredTags = filterIgnoreTags(cameraKey, ml)
        if (ml.tags.length > 0) {
          return <a target="_blank" href={img}><Stack>{ml.tags.map((t, idx) => <Text key={idx} variant="mediumPlus" >{t.tag} ({t.probability})</Text>)}</Stack></a>
        } else {
          return <a target="_blank" href={img}><Text variant="mediumPlus" >ML Image</Text></a>
        }
      } else {
        return <Text styles={{ root: {color: 'red'}}} variant="mediumPlus">{ml.code}: {ml.stderr} {ml.error}</Text>
      }
    } else if (ffmpeg) {
      if (ffmpeg.success) {
        return <a key={idx} target="_blank" href={img}><Text variant="mediumPlus">Image</Text></a>
      } else {
        return <Text variant="mediumPlus">Error: {ffmpeg.stderr}</Text>
      }
    } else {
      return <Text variant="mediumPlus">please wait..</Text>
    }
  }

  return (
    <main>

      <nav className="header">
        <div className="logo">Home Surveillance</div>
        <input className="menu-btn" type="checkbox" id="menu-btn" />
        <label className="menu-icon" htmlFor="menu-btn"><span className="navicon"></span></label>
        <ul className="menu">
          <li><a href="/grafana/?orgId=1">Grafana</a></li>
          <li><a href="/network">Network Control</a></li>
        </ul>
      </nav>

      <div style={{ "height": "34px", "width": "100%" }} />

      <PanelSettings data={data} panel={panel} setPanel={setPanel} getServerData={getServerData}/>

      <Stack horizontal wrap >


        {showPlayer &&
          <Stack.Item styles={{ root: { width: "700px" } }} grow={1}>
            <VideoJS  options={{
                autoplay: true,
                muted:"muted",
                controls: true,
                aspectRatio: '4:3',
                liveui: true
              }} onReady={handlePlayerReady}/>


          </Stack.Item>
        }

        <Stack.Item styles={showPlayer ? { root: { width: "420px" } } : {}} grow={0}>

          <CommandBar
            items={[
              {
                key: 'camera',
                text: currentPlaying ? data.cameras.find(c => c.key === currentPlaying.cKey)?.name : 'Live',
                split: true,
                cacheKey: 'myCacheKey', // changing this key will invalidate this item's cache
                iconProps: { iconName: 'Webcam2' },
                onClick: () => {
                  currentPlaying && playVideo(currentPlaying.cKey)
                },
                subMenuProps: {
                  items: data.cameras.filter(c => c.enable_streaming).map(c => { return {
                      key: c.key,
                      text: c.name,
                      iconProps: { iconName: 'FrontCamera' },
                      onClick: () => playVideo(c.key)
                    }})/*.concat([{
                      key: 'all',
                      text: 'All',
                      iconProps: { iconName: 'FrontCamera' },
                      onClick: () => playVideo('all')
                    }])*/
                }
              },
              {
                key: 'mode',
                text: mode,
                iconProps: { iconName: 'Filter' },
                subMenuProps: {
                  items: [
                    {
                      key: 'movement',
                      text: 'Movement',
                      onClick: () => setMode ('Movement'),
                    },
                    {
                      key: 'filtered',
                      text: 'Filtered',
                      onClick: () => setMode ('Filtered'),
                    },
                    {
                      key: 'time',
                      text: 'Time',
                      onClick: () => setMode ('Time'),
                    }
                  ]
                }
              },
              {
                key: 'refresh',
                text: 'Refresh',
                checked: data.status === "fetching",
                iconProps: { iconName: 'Refresh' },
                onClick: getServerData,
              },
              {
                key: 'download',
                text: 'Download',
                iconProps: { iconName: 'Download' },
                onClick: downloadMovement,
              }
            ]}
            farItems={[{
              key: 'tile',
              text: 'Image view',
              // This needs an ariaLabel since it's icon-only
              ariaLabel: 'Image view',
              iconOnly: true,
              checked: !showPlayer,
              iconProps: { iconName: 'Tiles' },
              onClick: () => setShowPlayer(!showPlayer)
            },{
              key: 'settings',
              text: 'Settings',
              // This needs an ariaLabel since it's icon-only
              ariaLabel: 'Settings',
              iconOnly: true,
              iconProps: { iconName: 'Settings' },
              subMenuProps: {
                items: [{
                    key: 'settings',
                    text: 'Settings',
                    iconProps: { iconName: 'DataManagementSettings' },
                    onClick: () => {
                      setPanel({...panel, open: true, key: 'settings', invalidArray:[], heading: 'General and Disk Settings', values: { ...data.config.settings }})
                    }
                }].concat(data.cameras.map(c => { return {
                    key: c.key,
                    text: `Settings "${c.name}"`,
                    iconProps: { iconName: 'FrontCamera' },
                    ['data-automation-id']: 'newEmailButton', // optional
                    onClick: () => {
                      setPanel({...panel, open: true, key: 'edit', invalidArray: [],  heading: 'Edit Camera Details', values: {
                        key: c.key,
                        name: c.name,
                        folder: c.folder,
                        disk: c.disk,
                        secWithoutMovement: c.secWithoutMovement,
                        secMaxSingleMovement: c.secMaxSingleMovement,
                        mSPollFrequency: c.mSPollFrequency,
                        segments_prior_to_movement: c.segments_prior_to_movement,
                        segments_post_movement: c.segments_post_movement,
                        ignore_tags: c.ignore_tags,
                        enable_streaming: c.enable_streaming,
                        enable_movement: c.enable_movement,
                      }})
                    }
                  }}).concat (
                  {
                    key: 'Add',
                    text: 'Add Camera',
                    iconProps: { iconName: 'Add' },
                    onClick: () => setPanel({...panel, open: true, key: 'new', invalidArray: [], heading: 'Add New Camera', values: {
                      secWithoutMovement: 10,
                      secMaxSingleMovement: 600,
                      mSPollFrequency: 1000,
                      disk: data.config.settings.disk_base_dir,
                      segments_prior_to_movement: 10, // 20 seconds (2second segments)
                      segments_post_movement: 10, // 20 seconds (2second segments)
                      ignore_tags: ['car'],
                      enable_streaming: true,
                      enable_movement: true,
                    }}),
                  }
                ))
              }
            }]}
            ariaLabel="Inbox actions"
            primaryGroupAriaLabel="Email actions"
            farItemsGroupAriaLabel="More actions"
          />
       
              <DetailsList
                className="scrollMe"
                isHeaderVisible={false}
                items={data.movements.map(m => { 
                  const camera =  data.cameras.find(c => c.key === m.movement.cameraKey)
                  return  {
                    key: m.key,
                    ...m.movement, 
                    startDate_en_GB: m.startDate_en_GB, 
                    ...(camera && { 
                      cameraName: camera.name, 
                      segments_prior_to_movement: mode === "Time" ? 0: camera.segments_prior_to_movement, 
                      segments_post_movement: mode === "Time" ? 0: camera.segments_post_movement
                    })
                }})}
                compact={true}
                setKey="key"
                onShouldVirtualize={() => {
                  return false;
                }}
                columns={[
                  {
                    key: "startDate_en_GB", 
                    isRowHeader: true,
                    fieldName: "startDate_en_GB",
                    minWidth: 120,
                    maxWidth: 120
                  },
                  {
                    key: "cameraName", 
                    fieldName: "cameraName",
                    minWidth: 38,
                    maxWidth: 38
                    //onRender: (item) => <Text variant='medium' styles={{root: {background: 'yellow'}}} >{item.cameraName}</Text>
                  },
                  {
                    key: "seconds", 
                    fieldName: "seconds",
                    minWidth: 25,
                    maxWidth: 30
                  }
                ].concat(mode !== "Time" && showPlayer ? {
                  name: "Save", 
                  key: "stat",  
                  onRender: renderTags
                } : [])
                }
                selection={_selection}
                selectionMode={SelectionMode.single}
                onItemInvoked={_debug}
                //onActiveItemChanged={_onActiveItemChanged}
              />
           
 
        </Stack.Item>


      </Stack>
    </main >
  )
}

export default App;
