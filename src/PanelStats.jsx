import React from 'react';

import {
    Text,
    Divider,
    makeStyles,
    tokens,
    shorthands,
    Dialog,
    DialogSurface,
    DialogTitle,
    DialogContent,
    DialogActions,
    DialogTrigger,
    DialogBody,
    Button,
    Spinner,
    Badge
} from "@fluentui/react-components";

const useStyles = makeStyles({
    base: {
        display: "flex",
        flexDirection: "column",
        rowGap: tokens.spacingVerticalS,
    },
    table: {
        width: "100%",
        borderCollapse: "collapse",
        fontSize: tokens.fontSizeBase200,
        "& th, & td": {
            ...shorthands.padding("4px", "8px"),
            textAlign: "left",
            borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
        },
        "& th": {
            fontWeight: tokens.fontWeightSemibold,
            backgroundColor: tokens.colorNeutralBackground3,
        },
        "& td:not(:first-child)": {
            textAlign: "right",
        },
        "& th:not(:first-child)": {
            textAlign: "right",
        },
    },
    summary: {
        display: "flex",
        ...shorthands.gap("16px"),
        flexWrap: "wrap",
    },
    statBox: {
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        ...shorthands.padding("8px", "16px"),
        backgroundColor: tokens.colorNeutralBackground3,
        ...shorthands.borderRadius("4px"),
        minWidth: "80px",
    },
});

export function PanelStats({ open, onClose }) {
    const [stats, setStats] = React.useState(null);
    const [loading, setLoading] = React.useState(false);
    const [error, setError] = React.useState(null);
    const styles = useStyles();

    React.useEffect(() => {
        if (open) {
            setLoading(true);
            setError(null);
            fetch('/api/stats')
                .then(res => res.json())
                .then(data => {
                    setStats(data);
                    setLoading(false);
                })
                .catch(err => {
                    setError(String(err));
                    setLoading(false);
                });
        }
    }, [open]);

    if (!open) return null;

    return (
        <Dialog modalType='modal' open={open}>
            <DialogSurface style={{ maxWidth: '600px' }}>
                <DialogBody>
                    <DialogTitle>Database Stats</DialogTitle>
                    <DialogContent className={styles.base}>
                        {loading && <Spinner label="Loading stats..." />}
                        {error && <Text style={{ color: tokens.colorPaletteRedForeground1 }}>Error: {error}</Text>}

                        {stats && !loading && <>
                            <div className={styles.summary}>
                                <div className={styles.statBox}>
                                    <Text size={500} weight="bold">{stats.totalCameras}</Text>
                                    <Text size={200}>Cameras</Text>
                                </div>
                                <div className={styles.statBox}>
                                    <Text size={500} weight="bold">{stats.totalMovements?.toLocaleString()}</Text>
                                    <Text size={200}>Movements</Text>
                                </div>
                            </div>

                            {stats.cameras?.map(cam => (
                                <div key={cam.cameraKey}>
                                    <Divider>
                                        <b>{cam.cameraName}</b>
                                        <Badge appearance="filled" style={{ marginLeft: '8px' }}>{cam.total.toLocaleString()}</Badge>
                                    </Divider>

                                    <table className={styles.table}>
                                        <tbody>
                                            <tr><td>Oldest</td><td>{cam.oldest}</td></tr>
                                            <tr><td>Newest</td><td>{cam.newest}</td></tr>
                                        </tbody>
                                    </table>

                                    <Text size={200} weight="semibold" style={{ marginTop: '4px', display: 'block' }}>Per Day</Text>
                                    <table className={styles.table}>
                                        <thead>
                                            <tr><th>Date</th><th>Count</th></tr>
                                        </thead>
                                        <tbody>
                                            {cam.perDay?.slice(-14).map(d => (
                                                <tr key={d.date}><td>{d.date}</td><td>{d.count}</td></tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            ))}
                        </>}
                    </DialogContent>
                    <DialogActions>
                        <DialogTrigger disableButtonEnhancement>
                            <Button appearance="secondary" onClick={onClose}>Close</Button>
                        </DialogTrigger>
                    </DialogActions>
                </DialogBody>
            </DialogSurface>
        </Dialog>
    );
}
