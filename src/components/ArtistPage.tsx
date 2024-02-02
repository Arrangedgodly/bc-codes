import { useParams } from "react-router-dom";
import { useState, useEffect } from "react";
import { getArtistDocumentBySlug, getRelease } from "../firebase";
import Artist from "./Artist";

const ArtistPage = () => {
  const { artistSlug } = useParams();
  const [artist, setArtist] = useState<any>(null);
  useEffect(() => {
    const fetchArtist = async () => {
      const artistData = await getArtistDocumentBySlug(artistSlug || "");
      let releasesData = [];
      if (artistData) {
        for (let i = 0; i < artistData.releases.length; i++) {
          const releaseData = await getRelease(artistData.releases[i]);
          releasesData[i] = releaseData;
          i++;
        }
        setArtist({ ...artistData, releases: releasesData });
      }
    };
    fetchArtist();
  }, [artistSlug]);
  return <div>{artist ? <Artist artist={artist} /> : <p>Loading...</p>}</div>;
};

export default ArtistPage;
