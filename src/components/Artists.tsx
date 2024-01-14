import Artist from "./Artist";
import Shortcut from "./Shortcut";
import Loading from "./Loading";
import { db } from "../firebase";
import {
  collection,
  getDocs,
  getDoc,
  DocumentReference,
} from "firebase/firestore";
import { useEffect, useState } from "react";
import { AlbumProps, ArtistProps } from "../types";


const Artists = () => {
  const [artists, setArtists] = useState<ArtistProps[]>([]);
  const [sortedArtists, setSortedArtists] = useState<ArtistProps[]>([]);
  const [loading, setLoading] = useState<boolean>(false);

  useEffect(() => {
    const fetchArtists = async () => {
      setLoading(true);
      try {
        const artistsCollection = collection(db, "artists");
        const artistsSnapshot = await getDocs(artistsCollection);
        const artistsList = await Promise.all(
          artistsSnapshot.docs.map(async (doc) => {
            const artistData = doc.data();
            const releases = await Promise.all(
              artistData.releases.map(async (releaseRef: DocumentReference) => {
                const releaseSnapshot = await getDoc(releaseRef);
                return releaseSnapshot.data() as AlbumProps;
              })
            );
            return {
              id: doc.id,
              name: artistData.name,
              location: artistData.location,
              releases,
            } as ArtistProps;
          })
        );
        setArtists(artistsList);
        setLoading(false);
      } catch (error) {
        console.error("Error fetching artists: ", error);
      }
    };
    fetchArtists();
  }, []);

  const filterArtistsWithReleases = (artists: ArtistProps[]): ArtistProps[] => {
    return artists.filter((artist) => artist.releases.length > 0);
  };

  useEffect(() => {
    setSortedArtists(filterArtistsWithReleases(artists));
  }, [artists]);

  return (
    <div className="h-full w-full carousel carousel-center mx-auto">
      {loading ? (
        <Loading />
      ) : (
        sortedArtists.map((artist) => {
          return (
            <Artist
              key={artist.name}
              name={artist.name}
              location={artist.location}
              releases={artist.releases}
            />
          );
        })
      )}
      <Shortcut />
    </div>
  );
};

export default Artists;
