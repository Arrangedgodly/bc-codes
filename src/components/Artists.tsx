import Artist from "./Artist";
import Loading from "./Loading";
import { db } from "../firebase";
import {
  collection,
  getDocs,
  getDoc,
  doc as document,
} from "firebase/firestore";
import { useEffect, useState } from "react";
import { ReleaseProps, ArtistProps } from "../types";

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
              artistData.releases.map(async (releaseId: string) => {
                const releaseRef = document(db, "releases", releaseId);
                const releaseSnapshot = await getDoc(releaseRef);
                return {
                  ...(releaseSnapshot.data() as ReleaseProps),
                  id: releaseId,
                };
              })
            );
            return {
              uid: doc.id,
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

  const sortArtistsAlphabetically = (artists: ArtistProps[]): ArtistProps[] => {
    return artists.sort((a, b) => {
      return a.name.localeCompare(b.name);
    });
  };

  useEffect(() => {
    setSortedArtists(
      sortArtistsAlphabetically(filterArtistsWithReleases(artists))
    );
  }, [artists]);

  return (
    <div className="h-full w-full carousel carousel-center mx-auto">
      {loading ? (
        <Loading />
      ) : (
        sortedArtists.map((artist) => {
          return (
            <Artist
              uid={artist.uid}
              key={artist.name}
              name={artist.name}
              location={artist.location}
              releases={artist.releases}
              followers={artist.followers}
            />
          );
        })
      )}
    </div>
  );
};

export default Artists;
