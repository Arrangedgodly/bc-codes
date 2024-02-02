import { useState, useEffect } from "react";
import {
  getArtistDocument,
  updateArtistName,
  updateArtistLocation,
  removeRelease,
  removeReleaseFromArtist,
  getRelease,
} from "../firebase";
import NewRelease from "./NewRelease";
import Release from "./Release";
import EditRelease from "./EditRelease";
import DeletePopup from "./DeletePopup";

type ProfileArtistProps = {
  artistProfile: any;
  setArtistProfile: any;
};

const ProfileArtist: React.FC<ProfileArtistProps> = ({ artistProfile, setArtistProfile }) => {
  const [artistName, setArtistName] = useState<string>(artistProfile?.name);
  const [newArtistName, setNewArtistName] = useState<boolean>(false);
  const [location, setLocation] = useState<string>(artistProfile?.location);
  const [newLocation, setNewLocation] = useState<boolean>(false);
  const [releases, setReleases] = useState<any[]>([]);
  const [activeRelease, setActiveRelease] = useState<any>(null);

  const handleArtistNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setArtistName(e.target.value);
  };

  const handleArtistNameSave = async () => {
    await updateArtistName(artistProfile.uid, artistName);
    setNewArtistName(false);
    setArtistProfile(await getArtistDocument(artistProfile.uid));
  };

  const handleLocationChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setLocation(e.target.value);
  };

  const handleLocationSave = async () => {
    await updateArtistLocation(artistProfile.uid, location);
    setNewLocation(false);
    setArtistProfile(await getArtistDocument(artistProfile.uid));
  };

  const deleteRelease = async () => {
    await removeRelease(activeRelease.id);
    await removeReleaseFromArtist(artistProfile.uid, activeRelease.id);
    setArtistProfile(await getArtistDocument(artistProfile.uid));
    setActiveRelease(null);
  };

  const sortReleasesByDate = (a: any, b: any) => {
    return (
      new Date(b.releaseDate).getTime() - new Date(a.releaseDate).getTime()
    );
  };

  useEffect(() => {
    if (artistName !== artistProfile?.name) {
      setNewArtistName(true);
    } else {
      setNewArtistName(false);
    }
  }, [artistName]);

  useEffect(() => {
    if (location !== artistProfile?.location) {
      setNewLocation(true);
    } else {
      setNewLocation(false);
    }
  }, [location]);

  useEffect(() => {
    if (artistProfile) {
      setArtistName(artistProfile.name);
      setLocation(artistProfile.location);
    }
  }, [artistProfile]);

  useEffect(() => {
    const fetchReleases = async () => {
      if (!artistProfile?.releases) return;
      const releaseData = await Promise.all(
        artistProfile.releases.map((releaseId: string) => getRelease(releaseId))
      );
      releaseData.sort(sortReleasesByDate);
      setReleases(releaseData);
    };

    fetchReleases();
  }, [artistProfile?.releases]);

  return (
    <>
      <div className="indicator m-3">
        <span className="indicator-item indicator-start badge badge-secondary text-xl">
          Artist/Label Name
        </span>
        {newArtistName && (
          <span
            className="indicator-item indicator-end indicator-bottom btn btn-info btn-sm text-xl"
            onClick={handleArtistNameSave}
          >
            Save
          </span>
        )}
        <input
          type="text"
          placeholder="Set your name"
          className="input input-bordered text-4xl input-lg text-center"
          value={artistName}
          onChange={handleArtistNameChange}
        />
      </div>
      <div className="indicator m-3">
        <span className="indicator-item indicator-start badge badge-secondary text-xl">
          Location
        </span>
        {newLocation && (
          <span
            className="indicator-item indicator-end indicator-bottom btn btn-info btn-sm text-xl"
            onClick={handleLocationSave}
          >
            Save
          </span>
        )}
        <input
          type="text"
          placeholder="Set your location"
          className="input input-bordered text-4xl input-lg text-center"
          value={location}
          onChange={handleLocationChange}
        />
      </div>
      <div className="divider"></div>
      <div className="flex flex-col items-center text-primary mb-5">
        <h2 className="text-4xl font-bold m-5">My Releases</h2>
        {releases && (
          <div className="flex flex-wrap items-center justify-center">
            {releases.map((release: any) => (
              <Release
                release={release}
                key={release.id}
                setActiveRelease={setActiveRelease}
              />
            ))}
          </div>
        )}
        <label htmlFor="new_release" className="btn btn-primary btn-lg text-xl">
          + New Release
        </label>
      </div>
      <NewRelease user={artistProfile} setUser={setArtistProfile} />
      {activeRelease && <EditRelease release={activeRelease} />}
      {activeRelease && <DeletePopup deleteRelease={deleteRelease} />}
    </>
  );
};

export default ProfileArtist;
