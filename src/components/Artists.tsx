import Artist from "./Artist";
import Shortcut from "./Shortcut";
import Loading from "./Loading";
import { Suspense } from "react";
import { db } from "../firebase";
import {
  collection,
  getDocs,
  getDoc,
  DocumentReference,
} from "firebase/firestore";
import { useEffect, useState } from "react";

type AlbumProps = {
  name: string;
  artist: string;
  image: string;
  link: string;
};

type ArtistProps = {
  name: string;
  location: string;
  releases: AlbumProps[];
};

const Artists = () => {
  const [artists, setArtists] = useState<ArtistProps[]>([]);

  useEffect(() => {
    const fetchArtists = async () => {
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
      } catch (error) {
        console.error("Error fetching artists: ", error);
      }
    };
    fetchArtists();
  }, []);

  return (
    <div className="h-full w-full carousel carousel-center mx-auto">
      <Suspense fallback={<Loading />}>
        {artists.map((artist) => (
          <Artist
            key={artist.name}
            name={artist.name}
            location={artist.location}
            releases={artist.releases}
          />
        ))}
      </Suspense>
      <Shortcut />
    </div>
  );
};

export default Artists;
